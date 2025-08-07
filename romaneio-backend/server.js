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
const PORT = 3012;

// Caminho onde os ZIPs são salvos
const saveDirectory = '\\\\10.0.2.1\\Dados\\Qualidade\\FOTOS';
// const saveDirectory = path.join(__dirname, 'uploads'); // para testes locais

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

const isVideo = (file) => /^video\//.test(file.mimetype);

// Comprimir vídeo
const compressVideo = (inputBuffer, filename) => {
  return new Promise((resolve, reject) => {
    const tmpInput = tmp.tmpNameSync({ postfix: path.extname(filename) });
    const tmpOutput = tmp.tmpNameSync({ postfix: '.mp4' });

    fs.writeFileSync(tmpInput, inputBuffer);

    ffmpeg(tmpInput)
      .output(tmpOutput)
      .videoCodec('libx264')
      .size('?x360')
      .outputOptions('-preset', 'fast', '-crf', '30')
      .on('end', () => {
        const compressedBuffer = fs.readFileSync(tmpOutput);
        fs.unlinkSync(tmpInput);
        fs.unlinkSync(tmpOutput);
        resolve(compressedBuffer);
      })
      .on('error', (err) => {
        console.error('[FFMPEG ERROR]', err);
        fs.unlinkSync(tmpInput);
        reject(err);
      })
      .run();
  });
};

// Upload de fotos e vídeos
app.post('/upload', upload.fields([
  { name: 'photos', maxCount: 20 },
  { name: 'videos', maxCount: 10 }
]), async (req, res) => {
  const nroContainer = req.body.nroContainer?.trim();
  const placa = req.body.placa?.trim();
  const destino = req.body.destino?.trim();
  const dataAtual = new Date().toISOString().split('T')[0];

  const photos = req.files['photos'] || [];
  const videos = req.files['videos'] || [];

  if (!nroContainer || !placa || !destino || (photos.length === 0 && videos.length === 0)) {
    return res.status(400).json({
      success: false,
      message: 'Nro Container, Placa, Destino ou arquivos ausentes.'
    });
  }

  const folderName = `${dataAtual} - ${nroContainer} - ${placa} - ${destino}`;
  let zipFilePath = path.join(saveDirectory, `${folderName}.zip`);
  let counter = 1;

  while (fs.existsSync(zipFilePath)) {
    zipFilePath = path.join(saveDirectory, `${folderName}-${counter}.zip`);
    counter++;
  }

  try {
    const zip = new JSZip();
    const filenameCounts = {};

    const addFilesToZip = async (files, prefix = '') => {
      for (const file of files) {
        const ext = path.extname(file.originalname);
        const baseName = path.basename(file.originalname, ext).replace(/\s+/g, '_');
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

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(zipFilePath, zipBuffer);

    console.log(`[OK] ZIP salvo em: ${zipFilePath}`);
    res.json({
      success: true,
      message: `Arquivo salvo como "${path.basename(zipFilePath)}" contendo ${photos.length} foto(s) e ${videos.length} vídeo(s).`
    });
  } catch (err) {
    console.error('[ERRO] Falha durante o processamento:', err.message || err);
    res.status(500).json({
      success: false,
      message: 'Erro ao processar ou salvar os arquivos.'
    });
  }
});

// Listar arquivos .zip do dia
app.get('/folders', (req, res) => {
  const dataAtual = new Date().toISOString().split('T')[0];

  try {
    const files = fs.readdirSync(saveDirectory);

    const folders = files
      .filter(name => name.endsWith('.zip') && name.startsWith(dataAtual))
      .map(name => {
        const semData = name.replace(`${dataAtual} - `, '').replace(/\.zip$/, '');
        return {
          rawName: name,
          displayName: semData
        };
      });

    res.json({ success: true, folders });
  } catch (err) {
    console.error('[ERRO AO LER PASTA FOTOS]:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao acessar pasta de destino.' });
  }
});

// Obter dados e fotos de um arquivo .zip
app.get('/folder/:zipName', (req, res) => {
  const zipFile = path.join(saveDirectory, req.params.zipName);

  if (!fs.existsSync(zipFile)) {
    return res.status(404).json({ success: false, message: 'Arquivo ZIP não encontrado.' });
  }

  try {
    const zip = new AdmZip(zipFile);
    const entries = zip.getEntries();

    const fotos = entries
      .filter(entry => entry.entryName.startsWith('foto_'))
      .map(entry => ({
        name: entry.entryName,
        base64: zip.readFile(entry).toString('base64')
      }));

    const match = req.params.zipName.match(/^(\d{4}-\d{2}-\d{2}) - (.+?) - (.+?) - (.+?)(?:-\d+)?\.zip$/);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Formato de nome de arquivo inválido.' });
    }

    const [, data, nroContainer, placa, destino] = match;

    res.json({
      success: true,
      data: { data, nroContainer, placa, destino },
      fotos
    });

  } catch (err) {
    console.error('[ERRO ao ler ZIP]:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao ler arquivo ZIP.' });
  }
});

// Iniciar o servidor HTTP
app.listen(PORT, () => {
  console.log(`✅ Backend rodando em: http://localhost:${PORT}`);
});
