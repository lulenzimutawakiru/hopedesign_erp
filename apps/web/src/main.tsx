import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './auth';
import App from './App';
import { applyPrefs } from './prefs';
import { startBuildWatch } from './buildwatch';
import './tokens.css';
import './styles.css';
import './styles/auth.css';
import './print.css';

applyPrefs();
startBuildWatch();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
