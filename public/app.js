const $ = (id) => document.getElementById(id);

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function shortHash(value) {
  if (!value) return '-';
  return value.length > 20 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function compact(value, limit = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

const eventPresentation = {
  run_started: ['Run started', 'Codex session initialized', 'normal'],
  codex_turn_started: ['Codex turn', 'Execution resumed', 'normal'],
  codex_turn_finished: ['Agent report', 'Structured turn completed', 'normal'],
  verifier_finished: ['Verifier checked', 'External completion check ran', 'warning'],
  verifier_preflight_finished: ['Preflight checked', 'Completion was checked before Codex started', 'warning'],
  invalid_gate_rejected: ['Gate rejected', 'Gate was outside the contract', 'error'],
  owner_gate_paused: ['Owner gate', 'Run paused for an allowed gate', 'warning'],
  run_exhausted: ['Budget reached', 'Iteration or runtime budget ended', 'error'],
  configuration_error: ['Configuration error', 'Codex rejected the runtime configuration', 'error'],
  integrity_violation: ['Integrity violation', 'A protected verifier input changed', 'error'],
  outcome_verified: ['Outcome verified', 'Receipt sealed', 'success'],
};

function eventDetail(event) {
  if (event.type === 'codex_turn_started') return `Iteration ${event.iteration}${event.resumed ? ' - resumed session' : ' - new session'}`;
  if (event.type === 'codex_turn_finished') return event.reportSummary || `Iteration ${event.iteration} - ${event.reportStatus || 'progress'} - exit ${event.exitCode}`;
  if (event.type === 'verifier_finished' || event.type === 'verifier_preflight_finished') return compact(event.output) || `Iteration ${event.iteration} - exit ${event.exitCode} - ${event.passed ? 'passed' : 'not yet passing'}`;
  if (event.type === 'outcome_verified') return `Receipt ${shortHash(event.receiptHash)}`;
  if (event.type === 'owner_gate_paused') return event.gate?.owner_action || event.gate?.reason || 'Owner action required';
  return eventPresentation[event.type]?.[1] || event.type.replaceAll('_', ' ');
}

function renderTimeline(events) {
  const timeline = $('timeline');
  timeline.replaceChildren();
  const ordered = [...events].reverse();
  for (const event of ordered) {
    const [title, , kind] = eventPresentation[event.type] || [event.type.replaceAll('_', ' '), '', 'normal'];
    const item = document.createElement('li');
    item.dataset.kind = event.type === 'verifier_finished' && event.passed ? 'success' : kind;

    const dot = document.createElement('span');
    dot.className = 'event-dot';
    dot.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    const heading = document.createElement('p');
    heading.className = 'event-title';
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.className = 'event-detail';
    detail.textContent = eventDetail(event);
    copy.append(heading, detail);

    const time = document.createElement('time');
    time.className = 'event-time';
    time.dateTime = event.at || '';
    time.textContent = event.at ? new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
    item.append(dot, copy, time);
    timeline.append(item);
  }
  $('event-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
}

async function json(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`${url}:${response.status}`);
    error.status = response.status;
    error.url = url;
    if (response.headers.get('content-type')?.includes('application/json')) {
      error.payload = await response.json().catch(() => null);
    }
    throw error;
  }
  return response.json();
}

async function loadData() {
  try {
    const [state, events] = await Promise.all([json('/api/state'), json('/api/events')]);
    const receipt = await json('/api/receipt').catch(() => null);
    const integrity = await json('/api/integrity').catch(() => ({ integrity: false }));
    return { state, events, receipt, integrity: integrity.integrity };
  } catch (error) {
    if (error.url === '/api/state' && error.status === 404 && error.payload?.error === 'state_not_found') {
      return {
        state: { status: 'not_started', objective: 'No run state yet', iteration: 0, maxIterations: 0 },
        events: [],
        receipt: null,
        integrity: false,
      };
    }
    if (error.payload) throw error;
    return json('/demo-data.json');
  }
}

function render({ state, events, receipt, integrity }) {
  const report = state.latestAgentReport || {};
  const verifier = state.latestVerifier || receipt?.verifier || {};
  $('objective').textContent = state.objective || 'No active objective';
  $('model').textContent = state.model || 'gpt-5.6-terra';
  $('status-pill').textContent = String(state.status || 'unknown').replaceAll('_', ' ');
  $('status-pill').dataset.status = state.status || 'unknown';
  $('iterations').textContent = `${state.iteration ?? receipt?.iterations ?? 0} / ${state.maxIterations ?? '-'}`;
  $('elapsed').textContent = formatDuration(state.elapsedMs ?? receipt?.elapsedMs);
  $('verifier').textContent = verifier.passed ? 'Passed' : verifier.exitCode === undefined ? 'Pending' : `Exit ${verifier.exitCode}`;
  $('integrity').textContent = integrity ? 'Valid' : receipt ? 'Invalid' : 'Pending';
  $('report-summary').textContent = report.summary || 'No report yet.';
  $('agent-state').textContent = report.status || '-';
  $('next-action').textContent = report.next_action || '-';
  $('exit-code').textContent = verifier.exitCode === undefined ? '-' : `${verifier.exitCode} / ${verifier.expectedExitCode}`;
  $('verify-duration').textContent = formatDuration(verifier.durationMs);
  $('output-hash').textContent = shortHash(verifier.outputHash);
  $('receipt-hash').textContent = shortHash(receipt?.receiptHash);
  $('updated').textContent = state.updatedAt ? `Updated ${new Date(state.updatedAt).toLocaleString()}` : 'Not updated';
  renderTimeline(events || []);
}

async function refresh() {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = 'Refreshing';
  try {
    render(await loadData());
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh';
  }
}

$('refresh').addEventListener('click', refresh);
await refresh();
