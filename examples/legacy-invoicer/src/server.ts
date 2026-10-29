import express from 'express';
import fs from 'node:fs';
import { createFernhillApp } from './app.ts';
import { DEFAULT_DB_PATH, openDb } from './db.ts';
import { seed } from './seed.ts';

if (!fs.existsSync(DEFAULT_DB_PATH)) seed();
const db = openDb();
const app = express();
app.use(createFernhillApp(() => db));
const port = Number(process.env.FERNHILL_PORT ?? 8790);
app.listen(port, () => console.log(`Fernhill Studio (legacy app) on http://localhost:${port}`));
