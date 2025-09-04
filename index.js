// server/index.js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import apiStateRouter from './api-state.js'; // same folder

const app = express();

// ---- middleware ----
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain', 'application/octet-stream'], limit: '1mb' }));
app.use(morgan('combined'));

// ---- routes ----
app.use('/api', apiStateRouter);

// tiny health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`IZZA persistence listening on ${PORT}`));
