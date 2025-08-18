// server.js (Opção A - tolerante + rota de rename)
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const tmp = require('tmp');
const AdmZip = require('adm-zip');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3012;

// Caminho onde os ZIPs são salvos
const saveDirectory =
  process.env.SAVE_DIR ||
  '\\\\10.0.2.1\\Dados\\Qualidade\\FOTOS';
// const saveDirectory = path.join(__dirname, 'uploads'); // para testes locais

// --- Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage em memória
const upload = multer({ storage: multer.memoryStorage() });

const isVideo = (file) => /^video\//i.test(file.mimetype);

// ---------------- Sanitização ----------------
function sanitizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[^a-zA-Z0-9 _-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// Para nomes de arquivos enviados: preserva a extensão, limpa apenas o "base"
function sanitizeFilename(original) {
  const ext = path.extname(original || '');
  const base = path.basename(original || '', ext);
  const cleanBase = sanitizeName(base);
  const finalBase = cleanBase.length ? cleanBase : 'arquivo';
  return finalBase + ext.toLowerCase();
}

// Data local BR (YYYY-MM-DD) — evita bug de UTC
function yyyymmddBR(offsetDays = 0) {
  const dt = new Date();
  dt.setDate(dt.getDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(dt);
  const dia = parts.find(p => p.type === 'day').value;
  const mes = parts.find(p => p.type === 'month').value;
  const ano = parts.find(p => p.type === 'year').value;
  return `${ano}-${mes}-${dia}`;
}

// Regex do padrão aceito de nome do ZIP
const ZIP_NAME_REGEX = /^(\d{4}-\d{2}-\d{2}) - (.+?) - (.+?) - (.+?)(?:-\d+)?\.zip$/i;

// Comprimir vídeo (gera MP4 H.264 360p)
const compressVideo = (inputBuffer, filename) => {
  return new Promise((resolve, reject) => {
    const tmpInput = tmp.tmpNameSync({ postfix: path.extname(filename) });
    const tmpOutput = tmp.tmpNameSync({ postfix: '.mp4' });

    fs.writeFileSync(tmpInput, inputBuffer);

    ffmpeg(tmpInput)
      .output(tmpOutput)
      .videoCodec('libx264')
      .size('?x360')
      .outputOptions('-preset', 'fast', '-crf', '30', '-movflags', '+faststart')
      .on('end', () => {
        try {
          const compressedBuffer = fs.readFileSync(tmpOutput);
          try { fs.unlinkSync(tmpInput); } catch {}
          try { fs.unlinkSync(tmpOutput); } catch {}
          resolve(compressedBuffer);
        } catch (e) {
          try { fs.unlinkSync(tmpInput); } catch {}
          try { fs.unlinkSync(tmpOutput); } catch {}
          reject(e);
        }
      })
      .on('error', (err) => {
        console.error('[FFMPEG ERROR]', err);
        try { fs.unlinkSync(tmpInput); } catch {}
        try { fs.unlinkSync(tmpOutput); } catch {}
        reject(err);
      })
      .run();
  });
};

// --- Upload de fotos e vídeos (MODO TOLERANTE p/ DEBUG)
app.post('/upload', upload.any(), async (req, res, next) => {
  try {
    // Log: nomes de campos que chegaram (para descobrir quem está fora do esperado)
    console.log('campos recebidos:', (req.files || []).map(f => f.fieldname));

    // Sanitiza imediatamente os campos de entrada
    const nroContainer = sanitizeName(req.body.nroContainer || '');
    const placa = sanitizeName(req.body.placa || '');
    const destino = sanitizeName(req.body.destino || '');
    const dataAtual = yyyymmddBR(0);

    // Separa arquivos por mimetype (independe do nome de campo)
    const allFiles = req.files || [];
    const photos = allFiles.filter(f => /^image\//i.test(f.mimetype));
    const videos = allFiles.filter(f => /^video\//i.test(f.mimetype));

    if (
      !nroContainer ||
      !placa ||
      !destino ||
      (photos.length === 0 && videos.length === 0)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Nro Container, Placa, Destino ou arquivos ausentes.',
      });
    }

    // Garante que o diretório existe
    try {
      if (!fs.existsSync(saveDirectory)) {
        fs.mkdirSync(saveDirectory, { recursive: true });
      }
    } catch (e) {
      console.error('[ERRO AO CRIAR DIRETÓRIO]:', e.message);
      return res.status(500).json({ success: false, message: 'Pasta de destino indisponível.' });
    }

    // Monta nome de pasta/zip com campos já sanitizados
    const folderName = `${dataAtual} - ${nroContainer} - ${placa} - ${destino}`;
    const baseZipName = `${folderName}.zip`;
    const zipFilePath = path.join(saveDirectory, baseZipName);

    // Remove versões antigas (ex.: "-1.zip", "-2.zip") e também o base se existir
    try {
      const files = fs.readdirSync(saveDirectory);
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapeRegex(folderName)}(?:-\\d+)?\\.zip$`, 'i');
      for (const f of files) {
        if (regex.test(f)) {
          try { fs.unlinkSync(path.join(saveDirectory, f)); } catch {}
        }
      }
    } catch (e) {
      console.warn('[AVISO] Não foi possível limpar versões antigas:', e.message);
    }

    try {
      const zip = new JSZip();
      const filenameCounts = {};

      const addFilesToZip = async (files, prefix = '') => {
        for (const file of files) {
          // Sanitiza o nome original (mantém extensão real em minúsculo)
          const cleanOriginal = sanitizeFilename(file.originalname);
          const ext = path.extname(cleanOriginal) || '';
          const baseName = path.basename(cleanOriginal, ext);

          let finalName = `${prefix}${baseName}${ext}`;

          if (filenameCounts[finalName]) {
            filenameCounts[finalName]++;
            finalName = `${prefix}${baseName}_${filenameCounts[finalName]}${ext}`;
          } else {
            filenameCounts[finalName] = 0;
          }

          if (isVideo(file)) {
            const compressedBuffer = await compressVideo(file.buffer, finalName);
            const mp4Name = `${prefix}${baseName}.mp4`;
            zip.file(mp4Name, compressedBuffer);
          } else {
            zip.file(finalName, file.buffer);
          }
        }
      };

      await addFilesToZip(photos, 'foto_');
      await addFilesToZip(videos, 'video_');

      // Gera ZIP em memória
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      // Salva de forma "atômica": escreve num TMP e depois renomeia por cima do final
      const tmpZipPath = path.join(saveDirectory, `${folderName}.${Date.now()}.tmp`);
      fs.writeFileSync(tmpZipPath, zipBuffer);
      try { fs.unlinkSync(zipFilePath); } catch {}
      fs.renameSync(tmpZipPath, zipFilePath);

      console.log(`[OK] ZIP salvo em: ${zipFilePath}`);
      res.json({
        success: true,
        message: `Arquivo salvo como "${path.basename(
          zipFilePath
        )}" contendo ${photos.length} foto(s) e ${videos.length} vídeo(s).`,
      });
    } catch (err) {
      console.error('[ERRO] Falha durante o processamento:', err.message || err);
      return res.status(500).json({
        success: false,
        message: 'Erro ao processar ou salvar os arquivos.',
      });
    }
  } catch (err) {
    next(err);
  }
});

// --- Listar arquivos .zip de HOJE e ONTEM
app.get('/folders', (req, res) => {
  const hoje = yyyymmddBR(0);
  const ontem = yyyymmddBR(-1);

  try {
    const files = fs.readdirSync(saveDirectory);

    const folders = files
      .filter(
        (name) =>
          name.toLowerCase().endsWith('.zip') &&
          (name.startsWith(hoje) || name.startsWith(ontem))
      )
      .sort((a, b) => b.localeCompare(a)) // ordem desc
      .map((name) => {
        const dataPrefix = name.startsWith(hoje) ? hoje : ontem;
        const semData = name
          .replace(`${dataPrefix} - `, '')
          .replace(/\.zip$/i, '');
        return {
          rawName: name,
          displayName: semData,
          date: dataPrefix,
        };
      });

    res.json({ success: true, folders });
  } catch (err) {
    console.error('[ERRO AO LER PASTA FOTOS]:', err.message);
    res
      .status(500)
      .json({ success: false, message: 'Erro ao acessar pasta de destino.' });
  }
});

// --- Obter dados e fotos de um arquivo .zip
app.get('/folder/:zipName', (req, res) => {
  try {
    // Sanitização básica do nome
    const name = path.basename(req.params.zipName);
    if (!/\.zip$/i.test(name)) {
      return res
        .status(400)
        .json({ success: false, message: 'Nome de arquivo inválido.' });
    }

    const absSave = path.resolve(saveDirectory);
    const zipFile = path.resolve(absSave, name);
    if (!zipFile.startsWith(absSave + path.sep)) {
      return res
        .status(400)
        .json({ success: false, message: 'Caminho inválido.' });
    }

    if (!fs.existsSync(zipFile)) {
      return res
        .status(404)
        .json({ success: false, message: 'Arquivo ZIP não encontrado.' });
    }

    const zip = new AdmZip(zipFile);
    const entries = zip.getEntries();

    const fotos = entries
      .filter((entry) => entry.entryName.startsWith('foto_'))
      .map((entry) => ({
        name: entry.entryName,
        base64: zip.readFile(entry).toString('base64'),
      }));

    // Extrai metadados do nome do arquivo
    const match = name.match(ZIP_NAME_REGEX);
    if (!match) {
      return res.status(400).json({
        success: false,
        message: 'Formato de nome de arquivo inválido.',
      });
    }

    const [, data, nroContainer, placa, destino] = match;

    res.json({
      success: true,
      data: { data, nroContainer, placa, destino },
      fotos,
    });
  } catch (err) {
    console.error('[ERRO ao ler ZIP]:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao ler arquivo ZIP.' });
  }
});

// --- Renomear um arquivo .zip
app.post('/rename', (req, res) => {
  try {
    let { oldName, newName } = req.body || {};

    if (!oldName || !newName) {
      return res.status(400).json({ success: false, message: 'Parâmetros ausentes.' });
    }

    // Mantém apenas o basename para evitar path traversal
    oldName = path.basename(oldName);
    newName = path.basename(newName);

    if (!/\.zip$/i.test(oldName) || !/\.zip$/i.test(newName)) {
      return res.status(400).json({ success: false, message: 'Nome deve terminar com .zip' });
    }

    // Checa se o novo nome segue o padrão
    if (!ZIP_NAME_REGEX.test(newName)) {
      return res.status(400).json({
        success: false,
        message: 'Novo nome não segue o padrão "YYYY-MM-DD - CONTAINER - PLACA - DESTINO.zip".'
      });
    }

    const absSave = path.resolve(saveDirectory);
    const oldPath = path.resolve(absSave, oldName);
    const newPath = path.resolve(absSave, newName);

    // segurança: apenas dentro do diretório permitido
    if (!oldPath.startsWith(absSave + path.sep) || !newPath.startsWith(absSave + path.sep)) {
      return res.status(400).json({ success: false, message: 'Caminho inválido.' });
    }

    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ success: false, message: 'Arquivo de origem não encontrado.' });
    }

    // Se já existir um arquivo com o novo nome, remove para sobrescrever (ou retorne erro, se preferir)
    try {
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
    } catch {}

    fs.renameSync(oldPath, newPath);

    res.json({ success: true, message: `Renomeado para ${path.basename(newPath)}`, newName: path.basename(newPath) });
  } catch (err) {
    console.error('[ERRO AO RENOMEAR]', err.message);
    res.status(500).json({ success: false, message: 'Erro ao renomear arquivo.' });
  }
});

// ---------- MIDDLEWARE GLOBAL DE ERRO ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      type: 'MULTER_ERROR',
      code: err.code,
      field: err.field,
      message: err.message
    });
  }

  if (err) {
    console.error('[UNCAUGHT ERROR]', err);
    return res.status(500).json({
      success: false,
      type: 'SERVER_ERROR',
      message: err.message || 'Erro inesperado'
    });
  }

  return next();
});

// --- Iniciar o servidor HTTP
app.listen(PORT, () => {
  console.log(`Backend rodando em: http://10.0.2.2:${PORT}`);
});
