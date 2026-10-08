// Напоминания в Telegram. Считает тот же план, что и приложение, — логика одна на двоих.
// Отметок бот не видит (они в телефоне), поэтому говорит о плане, а не о факте.
import { loadSources } from '../src/domain/sources';
import { buildDay } from '../src/logic/calendar/materialize';
import { planWeek, stripRecordings } from '../src/logic/planner/plan';
import { dailyAutoTasks, recordingTasks, SUBJECT_RU } from '../src/logic/planner/autotasks';
import { mockModeFor } from '../src/logic/ege/mockmode';
import { applyDayOff, DEFAULT_HOLIDAYS } from '../src/logic/calendar/dayoff';
import { addDays, fmt, fmtDate, fmtDur, weekdayOf, WD_RU, WD_RU_FULL } from '../src/domain/time';
import type { Task } from '../src/domain/types';

const BASE = loadSources();

/** Московское время, где бы ни крутился раннер. Третьим аргументом можно подставить своё — для проверки. */
function msk(): { date: string; minute: number } {
  const override = process.argv[3];
  if (override) {
    const [d, t] = override.split('T');
    const [h, m] = (t ?? '12:00').split(':').map(Number);
    return { date: d, minute: h * 60 + m };
  }
  const s = new Date().toLocaleString('en-CA', {
    timeZone: 'Europe/Moscow', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const [date, time] = s.split(', ');
  const [h, m] = time.split(':').map(Number);
  return { date, minute: h * 60 + m };
}

/** План на один день — ровно тем же кодом, что в приложении. */
const HOLIDAYS = DEFAULT_HOLIDAYS.map((h, i) => ({ ...h, id: `h${i}`, updatedAt: 0 }));

function planFor(date: string) {
  const empty = new Map();
  // бот не видит твои правки каникул в приложении, поэтому идёт по типовому календарю
  const off = HOLIDAYS.find((h) => h.from <= date && date <= h.to);
  const day = stripRecordings(applyDayOff(buildDay(date, BASE, empty), off), new Set(), BASE.settings);
  const tasks: Task[] = [
    ...recordingTasks(BASE.lessons, BASE.courses, date, date),
    ...dailyAutoTasks(date, BASE.settings, undefined, undefined, mockModeFor(date, [])),
  ];
  const plan = planWeek({ days: [day], tasks, states: empty, checkins: empty, settings: BASE.settings, today: date });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return { day, plan, byId };
}

/** Длинные названия уроков курса режем: в сообщении нужен смысл, а не весь конспект. */
function short(title: string): string {
  const head = title.split(' — ')[0].trim();
  return head.length > 46 ? `${head.slice(0, 44).trimEnd()}…` : head;
}

const lessonsOf = (date: string) =>
  planFor(date).day.events.filter((e) => !['sleep', 'morning', 'commute', 'meal'].includes(e.kind)).sort((a, b) => a.start - b.start);

/* ---------- тексты ---------- */

function morning(): string {
  const { date } = msk();
  const { day, plan, byId } = planFor(date);
  const ev = day.events.filter((e) => ['school', 'course', 'workout'].includes(e.kind)).sort((a, b) => a.start - b.start);
  const own = plan.slots.filter((s) => byId.get(s.taskId)?.kind !== 'reading').sort((a, b) => a.start - b.start);

  const lines = [`<b>${WD_RU_FULL[weekdayOf(date)][0].toUpperCase()}${WD_RU_FULL[weekdayOf(date)].slice(1)}, ${fmtDate(date)}</b>`];
  if (ev.length) {
    lines.push('', '<b>Занятия</b>', ...ev.map((e) => `${fmt(e.start)} — ${e.title}`));
    // домой возвращаться только с тех занятий, куда надо ехать
    const away = ev.filter((e) => e.kind === 'school' || e.kind === 'course');
    if (away.length) { const last = away[away.length - 1]; lines.push(`Дома будешь около ${fmt(last.end + (last.kind === 'course' ? 45 : 10))}.`); }
  }
  if (own.length) {
    lines.push('', '<b>Своё</b>', ...own.slice(0, 5).map((s) => `${fmt(s.start)} — ${short(byId.get(s.taskId)!.title)} · ${fmtDur(s.end - s.start)}`));
  } else {
    lines.push('', 'Самостоятельной работе сегодня места нет — день держат занятия.');
  }
  const b = plan.budgets[date];
  if (b) lines.push('', `Бюджет на сегодня ${fmtDur(b.budgetMin)}, занято ${fmtDur(b.usedMin)}.`);
  return lines.join('\n');
}

/** Главное: блок плана, который начинается прямо сейчас. */
function now(windowMin = 15): string | null {
  const { date, minute } = msk();
  const { plan, byId, day } = planFor(date);

  const slot = plan.slots.find((s) => s.start >= minute && s.start < minute + windowMin);
  if (slot) {
    const t = byId.get(slot.taskId)!;
    const nextSlot = plan.slots.filter((s) => s.start >= slot.end).sort((a, b) => a.start - b.start)[0];
    const nextEvent = day.events.filter((e) => e.start >= slot.end && !['sleep', 'morning', 'meal'].includes(e.kind)).sort((a, b) => a.start - b.start)[0];
    const after = !nextSlot ? nextEvent : !nextEvent ? { start: nextSlot.start, title: short(byId.get(nextSlot.taskId)!.title) }
      : nextSlot.start <= nextEvent.start ? { start: nextSlot.start, title: short(byId.get(nextSlot.taskId)!.title) } : nextEvent;
    return [
      `<b>Пора: ${short(t.title)}</b>`,
      '',
      `${fmt(slot.start)}–${fmt(slot.end)} · ${fmtDur(slot.end - slot.start)}`,
      after ? `Потом в ${fmt(after.start)} — ${after.title}.` : 'Дальше на сегодня свободно.',
    ].join('\n');
  }

  // выход из дома: занятие с дорогой
  const leaving = day.events.find((e) => {
    const commute = e.kind === 'course' ? 40 : 0;
    const leave = e.start - commute - 10;
    return commute > 0 && leave >= minute && leave < minute + windowMin;
  });
  if (leaving) return `<b>Пора собираться</b>\n\n${fmt(leaving.start)} — ${leaving.title}. С дорогой выходить сейчас.`;

  return null;
}

function evening(): string {
  const { date } = msk();
  const tomorrow = addDays(date, 1);
  const ev = lessonsOf(tomorrow);
  const first = ev[0];
  const mock = mockModeFor(tomorrow, []);
  return [
    '<b>Отметь, как прошёл день</b>',
    '',
    'Приложение спросит по каждому делу — это минута.',
    first ? `Завтра начало в ${fmt(first.start)}: ${first.title}.` : 'Завтра занятий нет.',
    mock ? `И пробник по ${SUBJECT_RU[mock.subject].toLowerCase()}.` : '',
  ].filter(Boolean).join('\n');
}

function week(): string {
  const { date } = msk();
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, i + 1));
  const load = days.map((d) => {
    const { plan } = planFor(d);
    const b = plan.budgets[d];
    return { d, used: b?.usedMin ?? 0 };
  });
  const heaviest = [...load].sort((a, b) => b.used - a.used)[0];
  return [
    '<b>Неделя впереди</b>',
    '',
    ...load.map((x) => `${WD_RU[weekdayOf(x.d)]} ${fmtDate(x.d)} — ${fmtDur(x.used)}`),
    '',
    `Самый плотный — ${WD_RU_FULL[weekdayOf(heaviest.d)]}. Если что-то можно подвинуть, двигай с него.`,
  ].join('\n');
}

const MODES: Record<string, () => string | null> = { morning, evening, week, now: () => now() };

async function main() {
  const mode = process.argv[2] ?? 'now';
  const build = MODES[mode];
  if (!build) { console.error(`Режим: ${Object.keys(MODES).join(', ')}`); process.exit(1); }

  const text = build();
  if (!text) { console.log('Сейчас писать не о чем.'); return; }
  if (process.env.DRY_RUN) { console.log(`--- ${mode} ---\n${text}\n`); return; }

  const token = process.env.BOT_TOKEN, chat = process.env.CHAT_ID;
  if (!token || !chat) { console.error('Нет BOT_TOKEN или CHAT_ID в секретах репозитория.'); process.exit(1); }

  const body: Record<string, unknown> = { chat_id: chat, text, parse_mode: 'HTML', disable_notification: mode === 'week' };
  if (process.env.APP_URL) body.reply_markup = { inline_keyboard: [[{ text: 'Открыть Life OS', web_app: { url: process.env.APP_URL } }]] };

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json() as { ok: boolean; description?: string };
  if (!json.ok) { console.error('Telegram отказал:', json.description); process.exit(1); }
  console.log(`Отправлено: ${mode}`);
}

main();
