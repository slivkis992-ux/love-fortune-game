const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

// sharp уменьшает ваши фото до размера, который принимает Cloudflare (меньше 512 px)
let sharp = null;
try { sharp = require('sharp'); } catch { console.warn('⚠️ sharp не установлен (npm install): фото не будут уменьшаться.'); }

const ENV = process.env;
const missing = ['CF_ACCOUNT_ID', 'CF_API_TOKEN'].filter(k => !ENV[k]);
if (missing.length) {
  console.error('❌ Не заданы переменные: ' + missing.join(', ') + '. Локально они в .env, на Render в разделе Environment.');
  process.exit(1);
}
if (!ENV.ROOM_CODE) console.warn('⚠️ ROOM_CODE не задан: комнату сможет открыть кто угодно и потратить ваш лимит.');

const cfModel = (value, fallback) => (value && value.startsWith('@cf/') ? value : fallback);
const STORY_MODEL = cfModel(ENV.STORY_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
const IMAGE_MODEL = cfModel(ENV.IMAGE_MODEL, '@cf/black-forest-labs/flux-2-klein-4b');
const FALLBACK_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const SIZE = Math.min(1024, Math.max(512, parseInt(ENV.IMAGE_SIZE, 10) || 768));

const GEN_DIR = path.join(__dirname, 'public', 'generated');
fs.mkdirSync(GEN_DIR, { recursive: true });

const ROUNDS = [
  { title: 'Кто мы', icon: '🎭', options: ['Повара-соперники на кулинарном шоу', 'Охотники за сокровищами с картой от бабушки', 'Дрессировщики, потерявшие всех зверей', 'Агенты, охраняющие самый важный торт в мире', 'Пара из будущего, застрявшая в 2026-м', 'Участники реалити-шоу «Остаться живыми»'] },
  { title: 'Где мы', icon: '📍', options: ['Вокзал ночью', 'Супермаркет за минуту до закрытия', 'Замок с привидениями-бюрократами', 'Крыша небоскрёба во время грозы', 'Бесконечная очередь в МФЦ', 'Пляж, где всё слишком подозрительно'] },
  { title: 'Что пошло не так', icon: '💥', options: ['Пропал единственный ключ', 'Нас приняли за бывших друг друга', 'Появился двойник одного из нас', 'Всё вокруг заговорило рифмами', 'Закончился интернет, надо выжить офлайн', 'Выяснилось, что один из нас здесь самый главный'] },
  { title: 'Поворот', icon: '🌪', options: ['Вылезает клоун из первой части', 'Приходится танцевать, чтобы пройти дальше', 'Объявляется злодей, которого мы сами создали', 'Время повторяется по кругу', 'Дима и Аня меняются ролями', 'Появляется говорящий кот, который всё знает'] },
  { title: 'Финал', icon: '🏆', options: ['Оскар за лучшую пару', 'Сериал на 8 сезонов', 'Премия «Лучшая драка за последний круассан»', 'Сиквел обязателен', 'Награда «Самые странные герои года»', 'Открытый финал, продолжение завтра'] },
];

const SYSTEM = 'Ты сценарист игры «Любовная фортуна» для двух реальных людей: Димы и Ани (они пара). Пиши по-русски: смешно, с каплей драмы и неожиданным поворотом. 90–140 слов, 2–3 яркие реплики с указанием, кто говорит. Реплики оформляй через тире, двойные кавычки внутри текста не используй. Продолжай прошлые части, не пересказывая их. Ответь ТОЛЬКО JSON без пояснений: {"story":"текст","scene":"одно предложение по-английски: что видно на картинке (без текста и без имён)"}';

// ---------- состояние и рассылка ----------
const fresh = () => ({ round: 0, results: [], story: [], images: [], busy: false });
let state = fresh();
const clients = new Set();
const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const broadcast = m => clients.forEach(ws => send(ws, m));
const fullState = () => ({ type: 'state', rounds: ROUNDS, state });

// ---------- Cloudflare Workers AI ----------
async function cf(model, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ENV.CF_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ENV.CF_API_TOKEN, ...(isForm ? {} : { 'content-type': 'application/json' }) },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`Cloudflare ${model} ${res.status}: ` + JSON.stringify(j.errors || j).slice(0, 300));
  return j.result || {};
}

async function chat(system, user, maxTokens) {
  const r = await cf(STORY_MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
  });
  // Cloudflare иногда отдаёт ответ уже объектом, если он похож на JSON
  const out = r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) ?? '';
  return (typeof out === 'string' ? out : JSON.stringify(out)).trim();
}

const parseJson = s => {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.replace(/\n/g, '\\n')); } catch {}
  return null;
};

async function writeStory() {
  const r = state.round, last = r === ROUNDS.length - 1;
  const picks = state.results.map((x, i) => `${ROUNDS[i].title}: ${x.label}`).join('\n');
  const prompt = `Выпало по раундам:\n${picks}\n\nУже написано:\n${state.story.join('\n\n') || '(пока ничего)'}\n\nНапиши часть ${r + 1} из ${ROUNDS.length}. Обязательно используй то, что выпало сейчас: «${ROUNDS[r].title}: ${state.results[r].label}».${last ? ' Это финал: красиво закончи историю с романтичной ноткой.' : ''}`;
  let text = '';
  for (let i = 0; i < 2; i++) {
    text = await chat(SYSTEM, prompt, 900);
    const m = text.match(/\{[\s\S]*\}/);
    const o = m && parseJson(m[0]);
    if (o && o.story) return { story: String(o.story).trim(), scene: String(o.scene || '').trim() };
    console.warn(`Попытка ${i + 1}: ответ не в формате JSON`);
  }
  // запасной вариант: берём текст как есть
  const story = text.replace(/^[\s{]*"?story"?\s*:\s*"/i, '').replace(/",?\s*"scene"[\s\S]*$/i, '').replace(/["}\s]+$/, '').trim();
  if (!story) throw new Error('Модель вернула пустой ответ');
  return { story, scene: '' };
}

// ---------- картинки ----------
const photoCache = new Map();
const findPhoto = name => ['jpg', 'jpeg', 'png', 'webp'].map(e => path.join(__dirname, 'photos', `${name}.${e}`)).find(fs.existsSync);
async function photoBuffer(file) {
  if (photoCache.has(file)) return photoCache.get(file);
  let buf = fs.readFileSync(file);
  if (sharp) buf = await sharp(buf).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  photoCache.set(file, buf);
  return buf;
}

async function makeImage(scene, r) {
  const what = scene || 'a funny romantic adventure scene';
  const files = [findPhoto('dima'), findPhoto('anya')];
  let b64 = null, note = null;

  if (!IMAGE_MODEL.includes('flux-2')) {
    note = null; // выбрана модель без фото: рисуем без лиц
  } else if (!files.every(Boolean)) {
    note = 'Фото не найдены в папке photos (dima.jpg и anya.jpg), поэтому картинка нарисована без ваших лиц.';
  } else {
    try {
      const form = new FormData();
      form.append('prompt', `Fun cinematic comic-style illustration. The man from image 0 and the woman from image 1, a couple, their real faces and hairstyles clearly recognisable, in this scene: ${what}. Vivid colours. No text, letters or captions.`);
      form.append('width', String(SIZE));
      form.append('height', String(SIZE));
      form.append('input_image_0', new Blob([await photoBuffer(files[0])], { type: 'image/jpeg' }), 'dima.jpg');
      form.append('input_image_1', new Blob([await photoBuffer(files[1])], { type: 'image/jpeg' }), 'anya.jpg');
      b64 = (await cf(IMAGE_MODEL, form)).image;
    } catch (e) {
      console.error(e.message);
      note = 'С вашими лицами не получилось, поэтому картинка нарисована без них.';
    }
  }

  if (!b64) {
    const res = await cf(FALLBACK_IMAGE_MODEL, {
      prompt: `Fun cinematic comic-style illustration of a man and a woman, a couple, in this scene: ${what}. Vivid colours. No text, letters or captions.`,
      steps: 4,
    });
    b64 = res.image;
  }
  if (!b64) throw new Error('Cloudflare вернул ответ без картинки');

  const name = `r${r + 1}-${Date.now()}.${b64.startsWith('iVBOR') ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(GEN_DIR, name), Buffer.from(b64, 'base64'));
  // не копим старые картинки: оставляем последние 60
  const old = fs.readdirSync(GEN_DIR).sort();
  old.slice(0, Math.max(0, old.length - 60)).forEach(f => fs.rmSync(path.join(GEN_DIR, f), { force: true }));
  return { url: '/generated/' + name, note };
}

// ---------- ход игры ----------
async function spin() {
  const r = state.round;
  const index = crypto.randomInt(6);
  state.busy = true;
  state.results[r] = { index, label: ROUNDS[r].options[index] };
  broadcast({ type: 'spin', round: r, index, label: state.results[r].label });
  try {
    const { story, scene } = await writeStory();
    state.story[r] = story;
    broadcast({ type: 'story', round: r, story });
    try {
      const { url, note } = await makeImage(scene, r);
      state.images[r] = url;
      broadcast({ type: 'image', round: r, url });
      if (note) broadcast({ type: 'error', message: note });
    } catch (e) {
      console.error(e.message);
      broadcast({ type: 'error', message: 'Картинку не получилось нарисовать, история осталась. Возможно, закончился дневной лимит Cloudflare.' });
    }
  } catch (e) {
    console.error(e.message);
    state.results.length = r;
    broadcast({ type: 'error', message: 'Фортуна не смогла написать историю. Проверьте CF_ACCOUNT_ID и CF_API_TOKEN или лимит Cloudflare, и крутите заново.' });
    state.busy = false;
    return broadcast(fullState());
  }
  state.busy = false;
  broadcast({ type: 'idle' });
}

// ---------- сервер ----------
const app = express();
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

// пинг раз в 25 секунд, чтобы хостинг не обрывал соединение
setInterval(() => wss.clients.forEach(ws => {
  if (ws.isAlive === false) return ws.terminate();
  ws.isAlive = false;
  ws.ping();
}), 25000);

wss.on('connection', (ws, req) => {
  const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
  if (ENV.ROOM_CODE && code !== ENV.ROOM_CODE) return ws.close(4001);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);
  send(ws, fullState());
  broadcast({ type: 'peers', n: clients.size });
  ws.on('close', () => { clients.delete(ws); broadcast({ type: 'peers', n: clients.size }); });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (state.busy) return;
    const res = state.results[state.round];
    if (m.type === 'spin' && !res) spin();
    else if (m.type === 'next' && res && state.round < ROUNDS.length - 1) { state.round++; broadcast(fullState()); }
    else if (m.type === 'reset') { state = fresh(); broadcast(fullState()); }
  });
});

const PORT = ENV.PORT || 3000;
server.listen(PORT, () => console.log(`Фортуна готова: http://localhost:${PORT}/?code=${ENV.ROOM_CODE || ''}`));
