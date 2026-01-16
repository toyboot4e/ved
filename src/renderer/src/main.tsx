// TODO: Is it good idea to import here?
import './assets/main.css';
import './assets/editor.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

// biome-ignore lint/style/noNonNullAssertion: safe
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
