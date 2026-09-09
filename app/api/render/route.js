import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegStaticPath from 'ffmpeg-static';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

function extFor(file, fallback) {
  const original = file?.name || '';
  const ext = path.extname(original).toLowerCase();
  return ext && ext.length <= 6 ? ext : fallback;
}

async function resolveFfmpegPath() {
  const candidates = [
    ffmpegStaticPath,
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
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
      const tempBinary = path.join(os.tmpdir(), 'cp-social-ffmpeg');
      await fs.copyFile(candidate, tempBinary);
      await fs.chmod(tempBinary, 0o755);
      return tempBinary;
    } catch {}
  }

  throw new Error('FFmpeg não foi encontrado na Function.');
}

function runFfmpeg(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();

      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg encerrou com código ${code}. ${stderr.slice(-3500)}`
          )
        );
      }
    });
  });
}

export async function POST(request) {
  const workdir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cpsocial-')
  );

  try {
    const ffmpegPath = await resolveFfmpegPath();

    const form = await request.formData();

    const image = form.get('image');
    const audio = form.get('audio');

    if (!(image instanceof File) || !(audio instanceof File)) {
      return Response.json(
        { error: 'Envie os campos image e audio.' },
        { status: 400 }
      );
    }

    if (image.size + audio.size > MAX_INPUT_BYTES) {
      return Response.json(
        { error: 'Imagem + áudio excedem 4 MB neste teste.' },
        { status: 413 }
      );
    }

    const imagePath = path.join(
      workdir,
      `image${extFor(image, '.jpg')}`
    );

    const audioPath = path.join(
      workdir,
      `audio${extFor(audio, '.mp3')}`
    );

    const preparedImage = path.join(
      workdir,
      'prepared.jpg'
    );

    const outputPath = path.join(
      workdir,
      'reel.mp4'
    );

    await fs.writeFile(
      imagePath,
      Buffer.from(await image.arrayBuffer())
    );

    await fs.writeFile(
      audioPath,
      Buffer.from(await audio.arrayBuffer())
    );

    /*
     * ETAPA 1
     *
     * Prepara UMA única imagem em 1080x1920.
     * O blur é feito uma vez, em vez de ser recalculado
     * durante todos os frames do vídeo.
     */

    const prepareFilter = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase',
      'crop=1080:1920',
      'boxblur=18:6[bg]',
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2',
      'format=yuv420p'
    ].join(';');

    await runFfmpeg(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',

      '-i', imagePath,

      '-filter_complex', prepareFilter,

      '-frames:v', '1',

      '-q:v', '3',

      '-y',
      preparedImage
    ]);

    /*
     * ETAPA 2
     *
     * Agora o FFmpeg trabalha com uma imagem já pronta.
     * Não existe blur, crop ou overlay sendo recalculado
     * 30 vezes por segundo.
     */

    await runFfmpeg(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',

      '-loop', '1',

      '-framerate', '24',

      '-i', preparedImage,

      '-i', audioPath,

      '-map', '0:v:0',
      '-map', '1:a:0',

      '-c:v', 'libx264',

      '-preset', 'ultrafast',

      '-tune', 'stillimage',

      '-crf', '27',

      '-pix_fmt', 'yuv420p',

      '-r', '24',

      '-c:a', 'aac',

      '-b:a', '96k',

      '-ar', '44100',

      '-movflags', '+faststart',

      '-shortest',

      '-y',
      outputPath
    ]);

    const output = await fs.readFile(outputPath);

    if (output.byteLength > 4.3 * 1024 * 1024) {
      return Response.json(
        {
          error:
            'O vídeo foi gerado, mas ficou grande demais para ser devolvido diretamente pela Function.',
          details:
            `Tamanho: ${(output.byteLength / 1024 / 1024).toFixed(2)} MB`
        },
        { status: 507 }
      );
    }

    return new Response(output, {
      status: 200,

      headers: {
        'Content-Type': 'video/mp4',

        'Content-Disposition':
          'attachment; filename="cp-social-reel-teste.mp4"',

        'Cache-Control': 'no-store',

        'X-CP-Social-Renderer':
          'ffmpeg-static-optimized'
      }
    });

  } catch (error) {

    console.error('[CP Social Render]', error);

    return Response.json(
      {
        error: 'Falha ao renderizar o vídeo.',

        details:
          error instanceof Error
            ? error.message
            : String(error)
      },
      { status: 500 }
    );

  } finally {

    await fs.rm(
      workdir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});

  }
}