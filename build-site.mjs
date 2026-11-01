import {mkdir, copyFile, writeFile} from 'node:fs/promises';

const files = ['index.html', 'timetable.html', 'login.html', 'style.css',
  'landing.css', 'login.css', 'script.js', 'landing.js', 'login.js', 'session-ui.js'];
await mkdir('dist', {recursive:true});
await Promise.all(files.map(file => copyFile(file, `dist/${file}`)));
await writeFile('dist/_redirects',
  '/api/* https://bellhop-bh03.onrender.com/api/:splat 200!\n' +
  '/health https://bellhop-bh03.onrender.com/health 200!\n');
