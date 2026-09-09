# CP Social — Vercel Render Test

Prova de conceito para verificar se a conta Vercel Hobby consegue executar FFmpeg e transformar:

**imagem + áudio → MP4 vertical 1080×1920**

## Como publicar na Vercel

### Opção A — GitHub (recomendada)
1. Crie um repositório novo no GitHub.
2. Envie todos os arquivos desta pasta para o repositório.
3. Na Vercel, clique em **Add New → Project**.
4. Importe o repositório.
5. Framework Preset: **Next.js**.
6. Não precisa configurar variáveis de ambiente.
7. Clique em **Deploy**.

### Opção B — Vercel CLI
Se usa Node.js localmente:

```bash
npm install
npx vercel
```

## Primeiro teste

1. Abra a URL criada pela Vercel.
2. Use uma imagem JPG/PNG/WebP pequena.
3. Use um MP3 de 20–30 segundos.
4. Mantenha a soma de imagem + áudio abaixo de 4 MB.
5. Clique em **Gerar Reel de teste**.
6. Se aparecer o vídeo na página, FFmpeg funcionou na Vercel.

## O que o teste verifica

- se `ffmpeg-static` é empacotado corretamente;
- se o binário executa na Function Node.js;
- se há CPU/memória suficientes;
- se a renderização termina dentro de 300 segundos;
- se o MP4 H.264 + AAC é produzido;
- tempo real de renderização.

## Por que o teste limita a 4 MB?

Vercel Functions têm limite de aproximadamente 4,5 MB no corpo da requisição e na resposta. O CP Social final não deve mandar vídeos grandes desse jeito: ele deverá usar armazenamento (Vercel Blob/S3/R2 ou equivalente) e a Function trabalhar com URLs.

## Resultado esperado

O MP4 usa:
- 1080×1920;
- H.264;
- AAC;
- 30 fps;
- imagem original centralizada;
- fundo desfocado preenchendo 9:16;
- duração igual à duração do áudio.

## Correção 1.0.1 — FFmpeg ENOENT na Vercel

Se a versão anterior retornou `spawn .../ffmpeg ENOENT`, o Next.js empacotou a Function sem o executável nativo.
A versão 1.0.1 adiciona `next.config.mjs` com `serverExternalPackages` e `outputFileTracingIncludes`, forçando `ffmpeg-static` e seu binário a entrarem no bundle da rota `/api/render`.

Depois de substituir os arquivos no repositório, faça um novo deploy na Vercel. Para evitar artefatos antigos, prefira **Redeploy sem usar Build Cache**.
