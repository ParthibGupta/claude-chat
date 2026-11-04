// Slack bot that hands @mentions to the Claude Code CLI on this laptop.
// Uses Socket Mode, so no public URL is needed. Run with `npm start`.
import bolt from '@slack/bolt';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECTS_DIR = process.env.PROJECTS_DIR || join(homedir(), 'projects');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = 30 * 60 * 1000;
const SESSIONS_FILE = new URL('./sessions.json', import.meta.url);

const SYSTEM_PROMPT = `You are parthib-claude, a Slack bot running Claude Code on Parthib's laptop. You were @mentioned in a Slack thread, and your final message is posted back to that thread as-is.

Finding the project:
- Projects live in ${PROJECTS_DIR} (your cwd). Work out which one the request is about from the channel name/topic, the thread and the request itself.
- Folders like <repo>-<topic> are usually git worktrees of <repo>; the plain <repo> folder is the main checkout.
- If the repo isn't local, find it with gh (gh repo list, gh search repos) and clone it into ${PROJECTS_DIR}.
- If you genuinely can't tell which project is meant, ask in your reply instead of guessing.

Code changes:
- Never change the main checkout's working tree; it may have uncommitted work. Fetch, then make a new worktree off the default branch: git -C ${PROJECTS_DIR}/<repo> worktree add ${PROJECTS_DIR}/<repo>-<short-topic> -b <fix|feat|chore>/<short-topic> origin/<default-branch>
- Commit, push, and open a PR with gh. Never merge. Include the PR link in your reply.

Reading Slack:
- The thread is included below. For anything else (channel history, messages behind Slack links, attached files) call the Slack Web API with curl and $SLACK_BOT_TOKEN, e.g. conversations.history, conversations.replies, files.info; download url_private files with an "Authorization: Bearer $SLACK_BOT_TOKEN" header.
- A permalink https://<ws>.slack.com/archives/<channel>/p1793074390829619 means channel <channel>, ts 1793074390.829619. If it has ?thread_ts=..., that is the parent thread.

Replying:
- Keep it short. Use Slack mrkdwn: *bold*, _italic_, \`code\`, <https://url|text>, bullet lists with •. No # headings, no tables.`;

const app = new bolt.App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Slack thread ts -> { sessionId, lastTs } so follow-ups in a thread resume the same Claude session.
const sessions = existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) : {};
const saveSessions = () => writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
const busyThreads = new Set();

const userNames = new Map();
async function userName(client, id) {
  if (!userNames.has(id)) {
    const { user } = await client.users.info({ user: id }).catch(() => ({ user: null }));
    userNames.set(id, user?.profile?.display_name || user?.real_name || id);
  }
  return userNames.get(id);
}

async function formatMessage(client, m) {
  const who = m.user ? await userName(client, m.user) : m.username || m.bot_profile?.name || 'bot';
  let text = m.text || '';
  for (const [tag, id] of text.matchAll(/<@(U[A-Z0-9]+)>/g)) {
    text = text.replace(tag, '@' + (await userName(client, id)));
  }
  const files = (m.files || []).map((f) => `\n  [file ${f.id}: ${f.name}]`).join('');
  const time = new Date(Number(m.ts) * 1000).toLocaleString();
  return `[${time}] ${who}: ${text}${files}`;
}

async function buildPrompt(client, event, threadTs, session) {
  const { messages } = await client.conversations.replies({ channel: event.channel, ts: threadTs, limit: 200 });
  const request = await formatMessage(client, event);

  if (session) {
    const newer = messages.filter((m) => m.ts > session.lastTs && m.ts !== event.ts);
    const context = await Promise.all(newer.map((m) => formatMessage(client, m)));
    return [context.length ? `New messages in the thread since your last reply:\n${context.join('\n')}\n` : '', `New request:\n${request}`].join('\n');
  }

  const { channel } = await client.conversations.info({ channel: event.channel });
  const thread = await Promise.all(messages.filter((m) => m.ts !== event.ts).map((m) => formatMessage(client, m)));
  return [
    `Slack channel: #${channel.name || event.channel} (id ${event.channel})`,
    channel.topic?.value && `Channel topic: ${channel.topic.value}`,
    channel.purpose?.value && `Channel description: ${channel.purpose.value}`,
    thread.length ? `\nThread so far:\n${thread.join('\n')}` : '',
    `\nRequest:\n${request}`,
  ].filter(Boolean).join('\n');
}

function describeTool(block) {
  const i = block.input || {};
  const detail = i.description || i.command || i.file_path || i.pattern || i.url || '';
  return `${block.name}${detail ? ': ' + String(detail).split('\n')[0].slice(0, 120) : ''}`;
}

// Runs one Claude Code turn; calls onStep with a short description of each tool call.
function runClaude(prompt, resumeId, onStep) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--append-system-prompt', SYSTEM_PROMPT];
    if (resumeId) args.push('--resume', resumeId);
    const child = spawn(CLAUDE_BIN, args, { cwd: PROJECTS_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let result = null;
    let sessionId = resumeId;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);

    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content || []) if (block.type === 'tool_use') onStep(describeTool(block));
      }
      if (ev.type === 'result') result = ev;
    });
    child.on('error', (err) => (stderr += String(err)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (result && !result.is_error) return resolve({ ok: true, text: result.result, sessionId });
      const reason = signal === 'SIGTERM' ? 'Timed out after 30 minutes.' : result?.result || stderr.trim() || `claude exited with code ${code}`;
      resolve({ ok: false, text: reason, sessionId });
    });
  });
}

app.event('app_mention', async ({ event, client }) => {
  const threadTs = event.thread_ts || event.ts;
  const say = (text) => client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text });
  const react = (name, remove = false) =>
    client.reactions[remove ? 'remove' : 'add']({ channel: event.channel, timestamp: event.ts, name }).catch(() => {});

  if (busyThreads.has(threadTs)) return say("I'm still working on the previous request in this thread. Mention me again once I've replied.");
  busyThreads.add(threadTs);
  await react('eyes');
  const status = await say('On it…');

  // Edit the status message with the latest step, at most every 3 seconds.
  let lastUpdate = 0;
  const onStep = (step) => {
    if (Date.now() - lastUpdate < 3000) return;
    lastUpdate = Date.now();
    client.chat.update({ channel: event.channel, ts: status.ts, text: `On it… _${step}_` }).catch(() => {});
  };

  try {
    const session = sessions[threadTs];
    const prompt = await buildPrompt(client, event, threadTs, session);
    const { ok, text, sessionId } = await runClaude(prompt, session?.sessionId, onStep);
    if (sessionId) {
      sessions[threadTs] = { sessionId, lastTs: event.ts };
      saveSessions();
    }
    await client.chat.update({ channel: event.channel, ts: status.ts, text: ok ? 'Done.' : 'Failed.' });
    await say((ok ? text : `:x: ${text}`).slice(0, 39000) || '(no output)');
    await react('eyes', true);
    await react(ok ? 'white_check_mark' : 'x');
  } catch (err) {
    console.error(err);
    await say(`:x: Bot error: ${err.message}`);
    await react('eyes', true);
    await react('x');
  } finally {
    busyThreads.delete(threadTs);
  }
});

await app.start();
console.log(`parthib-claude is running (projects: ${PROJECTS_DIR})`);
