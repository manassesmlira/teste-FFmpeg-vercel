'use client';

import { useState } from 'react';

const MAX_BYTES = 4 * 1024 * 1024;

export default function Home() {
  const [image, setImage] = useState(null);
  const [audio, setAudio] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [videoUrl, setVideoUrl] = useState('');

  async function renderVideo(event) {
    event.preventDefault();
    setMessage('');
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl('');

    if (!image || !audio) {
      setMessage('Escolha uma imagem e um áudio.');
      return;
    }

    if (image.size + audio.size > MAX_BYTES) {
      setMessage('Para este teste, imagem + áudio devem somar no máximo 4 MB.');
      return;
    }

    const form = new FormData();
    form.append('image', image);
    form.append('audio', audio);

    try {
      setBusy(true);
      setMessage('Renderizando na Vercel…');
      const res = await fetch('/api/render', { method: 'POST', body: form });
      if (!res.ok) {
        let detail = '';
        try {
          const data = await res.json();
          detail = data?.error || data?.details || '';
        } catch {}
        throw new Error(detail || `Erro HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
      setMessage(`Pronto. MP4 gerado com ${(blob.size / 1024 / 1024).toFixed(2)} MB.`);
    } catch (err) {
      setMessage(`Falhou: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="card">
        <div className="badge">CP SOCIAL • PROVA DE CONCEITO</div>
        <h1>Imagem + áudio → Reel</h1>
        <p className="lead">Envie uma imagem e um áudio curto. A Vercel tentará gerar um MP4 vertical usando FFmpeg.</p>

        <form onSubmit={renderVideo}>
          <label>
            <span>Imagem</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setImage(e.target.files?.[0] || null)} />
            <small>JPG, PNG ou WebP.</small>
          </label>

          <label>
            <span>Áudio</span>
            <input type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav" onChange={(e) => setAudio(e.target.files?.[0] || null)} />
            <small>Comece com MP3 de 20 a 30 segundos.</small>
          </label>

          <div className="limit">Para evitar o limite de payload da Vercel neste teste: <strong>imagem + áudio ≤ 4 MB</strong>.</div>

          <button type="submit" disabled={busy}>{busy ? 'Gerando…' : 'Gerar Reel de teste'}</button>
        </form>

        {message && <div className="status">{message}</div>}

        {videoUrl && (
          <div className="result">
            <h2>Resultado</h2>
            <video src={videoUrl} controls playsInline />
            <a href={videoUrl} download="cp-social-reel-teste.mp4">Salvar MP4</a>
          </div>
        )}
      </section>
    </main>
  );
}
