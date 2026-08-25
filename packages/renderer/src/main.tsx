import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { injectStyles } from '@a2ui/react/styles';
import { App } from './App.tsx';
import './styles.css';

// A2UI's own structural CSS for the basic catalog (Row, Column, Card, inputs).
// Our stylesheet layers the dashboard look on top of it.
injectStyles();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
