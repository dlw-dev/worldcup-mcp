/**
 * Tools da Copa do Mundo 2026 — operam sobre data/tournament.json (commitado e
 * auto-atualizado por git/cron). Nomes batem com o que o adapter worker_proxy
 * da mcp.ai chama (matches, schedule, results, groups, standings, bracket,
 * teams, venues).
 */
import BUNDLED from "../data/tournament.json";

// Lê o JSON commitado direto do git (raw GitHub) a cada request, com cache de
// 5 min em memória + fallback pro snapshot bundlado. É isso que dá o
// "atualização do git automática": a GitHub Action commita data/tournament.json
// e o Worker passa a servir o novo em <=5min, SEM redeploy.
const RAW_URL =
  "https://raw.githubusercontent.com/dlw-dev/worldcup-mcp/main/data/tournament.json";
const TTL_MS = 5 * 60 * 1000;
let _cache = { data: BUNDLED, at: 0 };

async function getTournament() {
  const now = Date.now();
  if (_cache.at && now - _cache.at < TTL_MS) return _cache.data;
  try {
    const r = await fetch(RAW_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) {
      const data = await r.json();
      if (data && Array.isArray(data.matches)) {
        _cache = { data, at: now };
        return data;
      }
    }
  } catch {
    // rede falhou — segue com o cache/bundlado
  }
  _cache.at = now; // evita martelar o raw a cada request em caso de falha
  return _cache.data;
}

// Aliases PT/ES → nome no dataset (inglês do openfootball).
const TEAM_ALIASES = {
  brasil: "brazil",
  "coreia do sul": "south korea",
  "coreia do norte": "north korea",
  "africa do sul": "south africa",
  alemanha: "germany",
  espanha: "spain",
  franca: "france",
  inglaterra: "england",
  "estados unidos": "united states",
  eua: "united states",
  mexico: "mexico",
  "republica tcheca": "czech republic",
  "arabia saudita": "saudi arabia",
  croacia: "croatia",
  belgica: "belgium",
  holanda: "netherlands",
  "paises baixos": "netherlands",
  marrocos: "morocco",
  japao: "japan",
  suica: "switzerland",
  dinamarca: "denmark",
  escocia: "scotland",
  noruega: "norway",
};

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

function resolveTeamQuery(q) {
  const n = norm(q);
  return TEAM_ALIASES[n] || n;
}

function teamMatches(name, query) {
  if (!query) return true;
  const n = norm(name);
  const q = resolveTeamQuery(query);
  return n === q || n.includes(q) || q.includes(n);
}

function withLocal(m, timezone) {
  if (!m.kickoff_utc) return m;
  let local = null;
  try {
    local = new Intl.DateTimeFormat("pt-BR", {
      timeZone: timezone || "UTC",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(m.kickoff_utc));
  } catch {
    local = null;
  }
  return { ...m, kickoff_local: local, timezone: timezone || "UTC" };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function filterMatches(T, { date, team, group, stage, status }) {
  return T.matches.filter((m) => {
    if (date && m.date !== date) return false;
    if (group && m.group !== String(group).toUpperCase()) return false;
    if (stage && m.stage !== stage) return false;
    if (status && m.status !== status) return false;
    if (team && !(teamMatches(m.team1, team) || teamMatches(m.team2, team)))
      return false;
    return true;
  });
}

const meta = (T) => ({
  tournament: T.name,
  updated_at: T.updated_at,
  source: T.source,
});

export const TOOLS = {
  async matches(args = {}) {
    const T = await getTournament();
    const { date, team, group, stage, status, timezone } = args;
    let list = filterMatches(T, { date, team, group, stage, status });
    let note;
    // Sem nenhum filtro → jogos de hoje; se não houver, o próximo dia com jogos.
    if (!date && !team && !group && !stage && !status) {
      const today = todayUtc();
      const todays = list.filter((m) => m.date === today);
      if (todays.length) {
        list = todays;
        note = `Jogos de hoje (${today}).`;
      } else {
        const future = [...list]
          .filter((m) => m.date && m.date >= today)
          .sort((a, b) => a.date.localeCompare(b.date));
        const next = future[0]?.date;
        list = future.filter((m) => m.date === next);
        note = next
          ? `Sem jogos hoje (${today}). Próxima rodada: ${next}.`
          : "Torneio encerrado.";
      }
    }
    return {
      ...meta(T),
      note,
      count: list.length,
      matches: list.map((m) => withLocal(m, timezone)),
    };
  },

  async schedule(args = {}) {
    const T = await getTournament();
    const { date, stage, timezone } = args;
    const list = filterMatches(T, { date, stage });
    const byDate = {};
    for (const m of list) (byDate[m.date] ||= []).push(withLocal(m, timezone));
    return {
      ...meta(T),
      days: Object.keys(byDate)
        .sort()
        .map((d) => ({ date: d, matches: byDate[d] })),
    };
  },

  async results(args = {}) {
    const T = await getTournament();
    const { date, team, group } = args;
    const list = filterMatches(T, { date, team, group, status: "finished" });
    return {
      ...meta(T),
      count: list.length,
      results: list.map((m) => ({
        id: m.id,
        date: m.date,
        stage: m.stage,
        group: m.group,
        team1: m.team1,
        team2: m.team2,
        score1: m.score1,
        score2: m.score2,
        venue: m.venue,
      })),
    };
  },

  async groups(args = {}) {
    const T = await getTournament();
    const { group } = args;
    const all = T.groups;
    if (group) {
      const g = String(group).toUpperCase();
      return { ...meta(T), group: g, teams: all[g] || [] };
    }
    return {
      ...meta(T),
      groups: Object.keys(all)
        .sort()
        .map((g) => ({ group: g, teams: all[g] })),
    };
  },

  async standings(args = {}) {
    const T = await getTournament();
    const { group } = args;
    const all = T.standings;
    if (group) {
      const g = String(group).toUpperCase();
      return { ...meta(T), group: g, table: all[g] || [] };
    }
    return {
      ...meta(T),
      standings: Object.keys(all)
        .sort()
        .map((g) => ({ group: g, table: all[g] })),
    };
  },

  async bracket(args = {}) {
    const T = await getTournament();
    const { stage } = args;
    const stages = ["round32", "round16", "quarter", "semi", "third", "final"];
    const wanted = stage ? [stage] : stages;
    const ko = T.matches.filter(
      (m) => m.stage !== "group" && wanted.includes(m.stage),
    );
    const byStage = {};
    for (const m of ko)
      (byStage[m.stage] ||= []).push({
        id: m.id,
        date: m.date,
        team1: m.team1,
        team2: m.team2,
        score1: m.score1,
        score2: m.score2,
        status: m.status,
        venue: m.venue,
      });
    return {
      ...meta(T),
      bracket: stages
        .filter((s) => byStage[s])
        .map((s) => ({ stage: s, matches: byStage[s] })),
    };
  },

  async teams(args = {}) {
    const T = await getTournament();
    const { team, confederation } = args;
    if (team) {
      const found = T.teams.find((t) => teamMatches(t.name, team));
      if (!found) return { ...meta(T), error: `Seleção não encontrada: ${team}` };
      const matches = T.matches.filter(
        (m) => teamMatches(m.team1, found.name) || teamMatches(m.team2, found.name),
      );
      return { ...meta(T), team: found, matches };
    }
    let list = T.teams;
    if (confederation) {
      const c = norm(confederation);
      list = list.filter((t) => norm(t.confederation || "").includes(c));
    }
    return { ...meta(T), count: list.length, teams: list };
  },

  async venues(args = {}) {
    const T = await getTournament();
    const { city, venue } = args;
    let list = T.venues;
    if (city) list = list.filter((v) => norm(v.city).includes(norm(city)));
    if (venue) list = list.filter((v) => norm(v.venue).includes(norm(venue)));
    return { ...meta(T), count: list.length, venues: list };
  },
};

// Descritores pra tools/list (clientes MCP genéricos).
export const TOOL_DESCRIPTORS = [
  { name: "matches", description: "Jogos da Copa 2026 com placar e horário (filtros: date, team, group, stage, status, timezone). Sem filtro = jogos de hoje." },
  { name: "schedule", description: "Calendário agrupado por data (date, stage, timezone)." },
  { name: "results", description: "Resultados (placares finais) dos jogos encerrados (date, team, group)." },
  { name: "groups", description: "Composição dos 12 grupos (group)." },
  { name: "standings", description: "Tabela de classificação por grupo (group)." },
  { name: "bracket", description: "Chaveamento do mata-mata (stage)." },
  { name: "teams", description: "48 seleções; passe team para o perfil (team, confederation)." },
  { name: "venues", description: "16 estádios-sede (city, venue)." },
];
