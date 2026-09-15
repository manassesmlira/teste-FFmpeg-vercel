import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import dns from 'dns/promises';
import { spawn } from 'child_process';
import ffmpegStaticPath from 'ffmpeg-static';
import sharp from 'sharp';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_FORM_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_BYTES = 30 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4.3 * 1024 * 1024;

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 24;
const OUTPUT_DURATION = 30;

function extFor(file, fallback) {
  const ext = path.extname(file?.name || '').toLowerCase();
  return ext && ext.length <= 6 ? ext : fallback;
}

function runFfmpeg(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();

      if (stderr.length > 14000) {
        stderr = stderr.slice(-14000);
      }
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `FFmpeg encerrou com código ${code}. ${stderr.slice(-4000)}`
        )
      );
    });
  });
}

async function resolveFfmpegPath() {
  const candidates = [
    ffmpegStaticPath,
    path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      'ffmpeg'
    ),
    path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      'ffmpeg.exe'
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.F_OK);

      const tempPath = path.join(
        os.tmpdir(),
        'cp-social-ffmpeg'
      );

      await fs.copyFile(candidate, tempPath);
      await fs.chmod(tempPath, 0o755);

      return tempPath;
    } catch {}
  }

  throw new Error(
    `FFmpeg não encontrado: ${candidates.join(' | ')}`
  );
}

function isPrivateIp(ip) {
  if (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^0\./.test(ip) ||
    /^::1$/.test(ip) ||
    /^fc/i.test(ip) ||
    /^fd/i.test(ip)
  ) {
    return true;
  }

  const match = ip.match(/^172\.(\d+)\./);

  if (match) {
    const secondOctet = Number(match[1]);

    return (
      secondOctet >= 16 &&
      secondOctet <= 31
    );
  }

  return false;
}

async function assertPublicUrl(raw) {
  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL remota inválida.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URL remota inválida.');
  }

  if (
    ['localhost', '127.0.0.1', '::1'].includes(
      url.hostname
    )
  ) {
    throw new Error('Host remoto não permitido.');
  }

  const results = await dns.lookup(url.hostname, {
    all: true,
  });

  if (!results.length) {
    throw new Error(
      'Não foi possível resolver o host remoto.'
    );
  }

  if (
    results.some((result) =>
      isPrivateIp(result.address)
    )
  ) {
    throw new Error(
      'Host remoto privado não permitido.'
    );
  }

  return url;
}

async function downloadTo(raw, destination) {
  const url = await assertPublicUrl(raw);

  const response = await fetch(url, {
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(
      `Falha ao baixar mídia remota (${response.status}).`
    );
  }

  const contentLength = Number(
    response.headers.get('content-length') || 0
  );

  if (contentLength > MAX_REMOTE_BYTES) {
    throw new Error(
      'Mídia remota excede 30 MB. Comprima o arquivo antes de renderizar.'
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length > MAX_REMOTE_BYTES) {
    throw new Error(
      'Mídia remota excede 30 MB. Comprima o arquivo antes de renderizar.'
    );
  }

  await fs.writeFile(destination, buffer);

  return destination;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text, maxCharacters) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line
      ? `${line} ${word}`
      : word;

    if (
      candidate.length > maxCharacters &&
      line
    ) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function makeTextLines({
  lines,
  x,
  startY,
  fontSize,
  lineHeight,
  fontWeight,
}) {
  return lines
    .map((line, index) => {
      const y =
        startY +
        index * lineHeight;

      return `
        <text
          x="${x}"
          y="${y}"
          text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${fontSize}"
          font-weight="${fontWeight}"
          fill="#ffffff"
          stroke="#000000"
          stroke-opacity="0.50"
          stroke-width="2"
          paint-order="stroke fill"
        >${escapeXml(line)}</text>
      `;
    })
    .join('');
}

async function createOverlayPng({
  overlay,
  destination,
}) {
  const titleLines = wrapText(
    overlay.title || '',
    24
  );

  const bodyLines = wrapText(
    overlay.text || '',
    34
  );

  const titleFontSize = 72;
  const titleLineHeight = 88;

  const bodyFontSize = 48;
  const bodyLineHeight = 64;

  const titleHeight =
    titleLines.length *
    titleLineHeight;

  const bodyHeight =
    bodyLines.length *
    bodyLineHeight;

  const gap =
    titleLines.length &&
    bodyLines.length
      ? 55
      : 0;

  const totalTextHeight =
    titleHeight +
    gap +
    bodyHeight;

  let blockTop;

  if (overlay.position === 'top') {
    blockTop = 250;
  } else if (
    overlay.position === 'bottom'
  ) {
    blockTop =
      OUTPUT_HEIGHT -
      totalTextHeight -
      300;
  } else {
    blockTop =
      (OUTPUT_HEIGHT -
        totalTextHeight) /
      2;
  }

  const titleStartY =
    blockTop +
    titleFontSize;

  const bodyStartY =
    blockTop +
    titleHeight +
    gap +
    bodyFontSize;

  const darkLayer =
    overlay.dark !== false
      ? `
        <rect
          x="0"
          y="0"
          width="${OUTPUT_WIDTH}"
          height="${OUTPUT_HEIGHT}"
          fill="#000000"
          fill-opacity="0.34"
        />
      `
      : '';

  const titleSvg =
    makeTextLines({
      lines: titleLines,
      x: OUTPUT_WIDTH / 2,
      startY: titleStartY,
      fontSize: titleFontSize,
      lineHeight: titleLineHeight,
      fontWeight: 700,
    });

  const bodySvg =
    makeTextLines({
      lines: bodyLines,
      x: OUTPUT_WIDTH / 2,
      startY: bodyStartY,
      fontSize: bodyFontSize,
      lineHeight: bodyLineHeight,
      fontWeight: 500,
    });

  const svg = `
    <svg
      width="${OUTPUT_WIDTH}"
      height="${OUTPUT_HEIGHT}"
      viewBox="0 0 ${OUTPUT_WIDTH} ${OUTPUT_HEIGHT}"
      xmlns="http://www.w3.org/2000/svg"
    >
      ${darkLayer}
      ${titleSvg}
      ${bodySvg}
    </svg>
  `;

  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(destination);
}

function buildVideoBaseFilter(
  fitMode,
  overlayInputIndex
) {
  let base;

  if (fitMode === 'blur') {
    base =
      `[0:v]split=2[bgsrc][fgsrc];` +
      `[bgsrc]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},` +
      `boxblur=18:6[bg];` +
      `[fgsrc]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
  } else if (
    fitMode === 'contain'
  ) {
    base =
      `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black[base]`;
  } else {
    base =
      `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[base]`;
  }

  return (
    `${base};` +
    `[base][${overlayInputIndex}:v]` +
    `overlay=0:0:format=auto,` +
    `format=yuv420p[v]`
  );
}

function buildImageBaseFilter() {
  return (
    `[0:v]split=2[bgsrc][fgsrc];` +
    `[bgsrc]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},` +
    `boxblur=18:6[bg];` +
    `[fgsrc]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,` +
    `format=yuv420p[out]`
  );
}

async function renderVideoOverlay({
  ffmpeg,
  form,
  workdir,
  outputPath,
}) {
  const videoUrl = String(
    form.get('video_url') || ''
  ).trim();

  if (!videoUrl) {
    return Response.json(
      {
        error: 'Informe video_url.',
      },
      {
        status: 400,
      }
    );
  }

  const videoPath = path.join(
    workdir,
    'video.mp4'
  );

  await downloadTo(
    videoUrl,
    videoPath
  );

  let audioPath = '';

  const audioUrl = String(
    form.get('audio_url') || ''
  ).trim();

  const audio =
    form.get('audio');

  if (audioUrl) {
    audioPath = path.join(
      workdir,
      'audio-remote.mp3'
    );

    await downloadTo(
      audioUrl,
      audioPath
    );
  } else if (
    audio instanceof File
  ) {
    if (
      audio.size >
      MAX_FORM_BYTES
    ) {
      return Response.json(
        {
          error:
            'Áudio excede 4 MB.',
        },
        {
          status: 413,
        }
      );
    }

    audioPath = path.join(
      workdir,
      `audio${extFor(
        audio,
        '.webm'
      )}`
    );

    await fs.writeFile(
      audioPath,
      Buffer.from(
        await audio.arrayBuffer()
      )
    );
  }

  let overlay = {};

  try {
    overlay =
      JSON.parse(
        String(
          form.get('overlay') ||
            '{}'
        )
      ) || {};
  } catch {
    overlay = {};
  }

  const requestedFitMode =
    String(
      form.get('fit_mode') ||
        ''
    );

  const fitMode = [
    'crop',
    'blur',
    'contain',
  ].includes(
    requestedFitMode
  )
    ? requestedFitMode
    : 'crop';

  const overlayPath =
    path.join(
      workdir,
      'overlay.png'
    );

  await createOverlayPng({
    overlay,
    destination:
      overlayPath,
  });

  /*
   * Entradas:
   *
   * 0 = vídeo-base
   * 1 = overlay PNG
   * 2 = áudio, quando existir
   */

  const overlayInputIndex = 1;
  const audioInputIndex =
    audioPath ? 2 : null;

  const filterChain =
    buildVideoBaseFilter(
      fitMode,
      overlayInputIndex
    );

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',

    '-i',
    videoPath,

    '-loop',
    '1',

    '-i',
    overlayPath,
  ];

  if (audioPath) {
    args.push(
      '-i',
      audioPath
    );
  }

  args.push(
    '-filter_complex',
    filterChain,

    '-map',
    '[v]'
  );

  if (audioPath) {
    args.push(
      '-map',
      `${audioInputIndex}:a:0`,

      '-c:a',
      'aac',

      '-b:a',
      '96k',

      '-ar',
      '44100'
    );
  }

  args.push(
    '-c:v',
    'libx264',

    '-preset',
    'ultrafast',

    '-crf',
    '29',

    '-r',
    String(OUTPUT_FPS),

    '-pix_fmt',
    'yuv420p',

    '-movflags',
    '+faststart',

    '-t',
    String(
      OUTPUT_DURATION
    )
  );

  if (audioPath) {
    args.push(
      '-shortest'
    );
  }

  args.push(
    '-y',
    outputPath
  );

  await runFfmpeg(
    ffmpeg,
    args
  );

  return null;
}

async function renderImageAudio({
  ffmpeg,
  form,
  workdir,
  outputPath,
}) {
  const image =
    form.get('image');

  const audio =
    form.get('audio');

  if (
    !(
      image instanceof File
    ) ||
    !(
      audio instanceof File
    )
  ) {
    return Response.json(
      {
        error:
          'Envie image e audio.',
      },
      {
        status: 400,
      }
    );
  }

  if (
    image.size +
      audio.size >
    MAX_FORM_BYTES
  ) {
    return Response.json(
      {
        error:
          'Imagem + áudio excedem 4 MB.',
      },
      {
        status: 413,
      }
    );
  }

  const imagePath =
    path.join(
      workdir,
      `image${extFor(
        image,
        '.jpg'
      )}`
    );

  const audioPath =
    path.join(
      workdir,
      `audio${extFor(
        audio,
        '.mp3'
      )}`
    );

  const preparedImagePath =
    path.join(
      workdir,
      'prepared.jpg'
    );

  await fs.writeFile(
    imagePath,
    Buffer.from(
      await image.arrayBuffer()
    )
  );

  await fs.writeFile(
    audioPath,
    Buffer.from(
      await audio.arrayBuffer()
    )
  );

  const imageFilter =
    buildImageBaseFilter();

  await runFfmpeg(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',

      '-i',
      imagePath,

      '-filter_complex',
      imageFilter,

      '-map',
      '[out]',

      '-frames:v',
      '1',

      '-q:v',
      '3',

      '-y',
      preparedImagePath,
    ]
  );

  await runFfmpeg(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',

      '-loop',
      '1',

      '-framerate',
      String(
        OUTPUT_FPS
      ),

      '-i',
      preparedImagePath,

      '-i',
      audioPath,

      '-c:v',
      'libx264',

      '-preset',
      'ultrafast',

      '-tune',
      'stillimage',

      '-crf',
      '27',

      '-r',
      String(
        OUTPUT_FPS
      ),

      '-c:a',
      'aac',

      '-b:a',
      '96k',

      '-ar',
      '44100',

      '-pix_fmt',
      'yuv420p',

      '-movflags',
      '+faststart',

      '-shortest',

      '-y',
      outputPath,
    ]
  );

  return null;
}

export async function POST(
  request
) {
  const workdir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'cpsocial-'
      )
    );

  try {
    const ffmpeg =
      await resolveFfmpegPath();

    const form =
      await request.formData();

    const mode =
      String(
        form.get('mode') ||
          'image_audio'
      );

    const outputPath =
      path.join(
        workdir,
        'reel.mp4'
      );

    let earlyResponse =
      null;

    if (
      mode ===
      'video_overlay'
    ) {
      earlyResponse =
        await renderVideoOverlay({
          ffmpeg,
          form,
          workdir,
          outputPath,
        });
    } else {
      earlyResponse =
        await renderImageAudio({
          ffmpeg,
          form,
          workdir,
          outputPath,
        });
    }

    if (earlyResponse) {
      return earlyResponse;
    }

    const output =
      await fs.readFile(
        outputPath
      );

    if (
      output.byteLength >
      MAX_OUTPUT_BYTES
    ) {
      return Response.json(
        {
          error:
            'O vídeo final excedeu o limite de resposta da Function.',

          details:
            `${(
              output.byteLength /
              1024 /
              1024
            ).toFixed(
              2
            )} MB`,
        },
        {
          status: 507,
        }
      );
    }

    return new Response(
      output,
      {
        status: 200,

        headers: {
          'Content-Type':
            'video/mp4',

          'Content-Disposition':
            'attachment; filename="cp-social-reel.mp4"',

          'Cache-Control':
            'no-store',

          'X-CP-Social-Renderer':
            '1.2.0',

          'X-CP-Social-Resolution':
            `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,

          'X-CP-Social-Text-Engine':
            'sharp-svg',
        },
      }
    );
  } catch (error) {
    console.error(
      '[CP Social Render]',
      error
    );

    return Response.json(
      {
        error:
          'Falha ao renderizar o vídeo.',

        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 500,
      }
    );
  } finally {
    await fs
      .rm(workdir, {
        recursive: true,
        force: true,
      })
      .catch(() => {});
  }
}