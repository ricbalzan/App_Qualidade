// server.js
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

const upload = multer({ storage: multer.memoryStorage() });

const isVideo = (file) => /^video\//i.test(file.mimetype);

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
          fs.unlinkSync(tmpInput);
          fs.unlinkSync(tmpOutput);
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

// --- Upload de fotos e vídeos
app.post(
  '/upload',
  upload.fields([
    { name: 'photos', maxCount: 20 },
    { name: 'videos', maxCount: 10 },
  ]),
  async (req, res) => {
    const nroContainer = req.body.nroContainer?.trim();
    const placa = req.body.placa?.trim();
    const destino = req.body.destino?.trim();
    const dataAtual = yyyymmddBR(0);

    const photos = req.files?.['photos'] || [];
    const videos = req.files?.['videos'] || [];

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
          const ext = path.extname(file.originalname) || '';
          const baseName = path
            .basename(file.originalname, ext)
            .replace(/\s+/g, '_');

          let finalName = `${prefix}${baseName}${ext}`;

          if (filenameCounts[finalName]) {
            filenameCounts[finalName]++;
            finalName = `${prefix}${baseName}_${filenameCounts[finalName]}${ext}`;
          } else {
            filenameCounts[finalName] = 0;
          }

          if (isVideo(file)) {
            const compressedBuffer = await compressVideo(file.buffer, finalName);
            zip.file(finalName.replace(ext, '.mp4'), compressedBuffer);
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
      try { fs.unlinkSync(zipFilePath); } catch {} // remove se existir
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
  }
);

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
    const match = name.match(
      /^(\d{4}-\d{2}-\d{2}) - (.+?) - (.+?) - (.+?)(?:-\d+)?\.zip$/i
    );
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

// --- Iniciar o servidor HTTP
app.listen(PORT, () => {
  console.log(`Backend rodando em: http://localhost:${PORT}`);
});
