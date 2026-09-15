import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import dns from 'dns/promises';
import { spawn } from 'child_process';
import ffmpegStaticPath from 'ffmpeg-static';

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

  return lines.join('\n');
}

function buildVideoBaseFilter(fitMode) {
  if (fitMode === 'blur') {
    return (
      `[0:v]split=2[bgsrc][fgsrc];` +
      `[bgsrc]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},` +
      `boxblur=18:6[bg];` +
      `[fgsrc]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`
    );
  }

  if (fitMode === 'contain') {
    return (
      `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black[base]`
    );
  }

  return (
    `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,` +
    `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[base]`
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

  await downloadTo(videoUrl, videoPath);

  let audioPath = '';

  const audioUrl = String(
    form.get('audio_url') || ''
  ).trim();

  const audio = form.get('audio');

  if (audioUrl) {
    audioPath = path.join(
      workdir,
      'audio-remote.mp3'
    );

    await downloadTo(
      audioUrl,
      audioPath
    );
  } else if (audio instanceof File) {
    if (audio.size > MAX_FORM_BYTES) {
      return Response.json(
        {
          error: 'Áudio excede 4 MB.',
        },
        {
          status: 413,
        }
      );
    }

    audioPath = path.join(
      workdir,
      `audio${extFor(audio, '.webm')}`
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
          form.get('overlay') || '{}'
        )
      ) || {};
  } catch {
    overlay = {};
  }

  const requestedFitMode = String(
    form.get('fit_mode') || ''
  );

  const fitMode = [
    'crop',
    'blur',
    'contain',
  ].includes(requestedFitMode)
    ? requestedFitMode
    : 'crop';

  const title = wrapText(
    overlay.title || '',
    24
  );

  const body = wrapText(
    overlay.text || '',
    34
  );

  const titleFile = path.join(
    workdir,
    'title.txt'
  );

  const bodyFile = path.join(
    workdir,
    'body.txt'
  );

  await fs.writeFile(
    titleFile,
    title
  );

  await fs.writeFile(
    bodyFile,
    body
  );

  const baseFilter =
    buildVideoBaseFilter(
      fitMode
    );

  const position =
    overlay.position === 'top'
      ? '260'
      : overlay.position ===
          'bottom'
        ? 'h-text_h-320'
        : '(h-text_h)/2';

  let filterChain = baseFilter;

  /*
   * Importante:
   * não pode existir uma vírgula logo depois de [base].
   * O código antigo gerava:
   *
   * [base],drawbox=...
   *
   * Isso fazia o FFmpeg retornar:
   * No such filter: ''
   */

  if (overlay.dark !== false) {
    filterChain +=
      `;[base]` +
      `drawbox=` +
      `x=0:` +
      `y=0:` +
      `w=iw:` +
      `h=ih:` +
      `color=black@0.34:` +
      `t=fill,` +
      `format=yuv420p[base2]`;
  } else {
    filterChain +=
      `;[base]format=yuv420p[base2]`;
  }

  let currentVideo = 'base2';

  if (title) {
    filterChain +=
      `;[${currentVideo}]` +
      `drawtext=` +
      `font='Sans':` +
      `textfile='${titleFile}':` +
      `fontcolor=white:` +
      `fontsize=72:` +
      `line_spacing=14:` +
      `x=(w-text_w)/2:` +
      `y=${position}:` +
      `shadowcolor=black@0.6:` +
      `shadowx=3:` +
      `shadowy=3[t1]`;

    currentVideo = 't1';
  }

  if (body) {
    const bodyY = title
      ? `${position}+${Math.max(
          150,
          title.split('\n').length *
            92
        )}`
      : position;

    filterChain +=
      `;[${currentVideo}]` +
      `drawtext=` +
      `font='Sans':` +
      `textfile='${bodyFile}':` +
      `fontcolor=white:` +
      `fontsize=48:` +
      `line_spacing=12:` +
      `x=(w-text_w)/2:` +
      `y=${bodyY}:` +
      `shadowcolor=black@0.6:` +
      `shadowx=2:` +
      `shadowy=2[v]`;

    currentVideo = 'v';
  }

  if (currentVideo !== 'v') {
    filterChain +=
      `;[${currentVideo}]null[v]`;
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',

    '-i',
    videoPath,
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
      '1:a:0',

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
    String(OUTPUT_DURATION)
  );

  if (audioPath) {
    args.push('-shortest');
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
  const image = form.get('image');
  const audio = form.get('audio');

  if (
    !(image instanceof File) ||
    !(audio instanceof File)
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
    image.size + audio.size >
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

  const imagePath = path.join(
    workdir,
    `image${extFor(
      image,
      '.jpg'
    )}`
  );

  const audioPath = path.join(
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
      String(OUTPUT_FPS),

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
      String(OUTPUT_FPS),

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

    const mode = String(
      form.get('mode') ||
        'image_audio'
    );

    const outputPath =
      path.join(
        workdir,
        'reel.mp4'
      );

    let earlyResponse = null;

    if (
      mode === 'video_overlay'
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
            '1.1.1',

          'X-CP-Social-Resolution':
            `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
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