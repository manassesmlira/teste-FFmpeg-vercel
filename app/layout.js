import './styles.css';

export const metadata = {
  title: 'CP Social Render Test',
  description: 'Teste de imagem + áudio para Reel usando FFmpeg na Vercel.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
