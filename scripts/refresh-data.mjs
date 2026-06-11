#!/usr/bin/env node
/**
 * refresh-data.mjs — atualiza data/tournament.json com os dados da Copa 2026.
 *
 * Fontes:
 *   1. openfootball/worldcup.json (domínio público) — calendário/fixtures base
 *      (grupos, datas, horários, estádios, chaveamento).
 *   2. ESPN site.api (sem auth, público) — placar AO VIVO / resultados, fonte
 *      PRIMÁRIA. Mesclado por (data + home + away).
 *   3. football-data.org (opcional) — fallback do live overlay; o free tier
 *      NÃO inclui Copa do Mundo (a request volta vazia / 403), então só ajuda
 *      se houver token de plano pago. Ativa só se FOOTBALL_DATA_TOKEN existir.
 *
 * É o ÚNICO mecanismo de atualização: a GitHub Action roda isto num cron, e se
 * houver diff, commita data/ e re-deploya o Worker. O Worker serve o JSON
 * commitado (sem buscar API por request).
 *
 * Uso: node scripts/refresh-data.mjs   (escreve data/tournament.json)
 *      FOOTBALL_DATA_TOKEN=xxx node scripts/refresh-data.mjs
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "tournament.json");

const OPENFOOTBALL_URL =
  "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
// football-data.org: competição "WC" (FIFA World Cup). Free tier NÃO cobre.
const FOOTBALL_DATA_URL =
  "https://api.football-data.org/v4/competitions/WC/matches";
// ESPN unofficial: público, sem auth, cobre Copa do Mundo (slug fifa.world).
// Janela 2026-06-01..2026-07-20 cobre os 39 dias do torneio.
const ESPN_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260601-20260720";

// Aliases de nome de seleção entre ESPN e openfootball (slug-aware).
const ESPN_NAME_ALIASES = {
  czechia: "czech-republic",
  "ivory-coast": "cote-d-ivoire",
  "cote-divoire": "cote-d-ivoire",
  "republic-of-ireland": "ireland",
  "korea-republic": "south-korea",
  "korea-dpr": "north-korea",
  iran: "ir-iran",
};

function aliasSlug(s) {
  const k = slug(s);
  return ESPN_NAME_ALIASES[k] || k;
}

const STAGE_MAP = [
  [/matchday|group/i, "group"],
  [/round of 32|round32/i, "round32"],
  [/round of 16|round16/i, "round16"],
  [/quarter/i, "quarter"],
  [/semi/i, "semi"],
  [/third|3rd/i, "third"],
  [/final/i, "final"],
];

function stageOf(round) {
  for (const [re, key] of STAGE_MAP) if (re.test(round || "")) return key;
  return "group";
}

function groupLetter(group) {
  const m = /group\s+([A-L])/i.exec(group || "");
  return m ? m[1].toUpperCase() : null;
}

/** "13:00 UTC-6" + "2026-06-11" → ISO UTC. Sem offset → assume UTC. */
function kickoffUtc(date, time) {
  if (!date) return null;
  const m = /(\d{1,2}):(\d{2})(?:\s*UTC([+-]\d{1,2}))?/.exec(time || "");
  if (!m) return `${date}T00:00:00Z`;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const off = m[3] ? Number(m[3]) : 0;
  // hora local = hh:mm no offset `off`; UTC = local - off
  const utcMs =
    Date.parse(`${date}T00:00:00Z`) + (hh - off) * 3600_000 + mm * 60_000;
  return new Date(utcMs).toISOString();
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Slots do mata-mata no openfootball: "2A", "1E", "3A/B/C/D/F", "W73", "L101",
// "Winner Group A", etc. — não são seleções reais.
const isPlaceholder = (t) =>
  !t ||
  /winner|runner|loser|group|tbd/i.test(t) ||
  /^[wl]\d+$/i.test(t) || // W73, L101
  /^[123][a-l](\/[a-l])*$/i.test(t) || // 2A, 1E, 3A/B/C/D/F
  t.includes("/");

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function main() {
  const base = await fetchJson(OPENFOOTBALL_URL);
  const rawMatches = Array.isArray(base.matches) ? base.matches : [];

  const matches = rawMatches.map((m, i) => {
    const stage = stageOf(m.round);
    const grp = groupLetter(m.group);
    const score1 = m.score1 ?? m.score?.ft?.[0] ?? null;
    const score2 = m.score2 ?? m.score?.ft?.[1] ?? null;
    const finished = score1 != null && score2 != null;
    return {
      id: `m${String(i + 1).padStart(3, "0")}`,
      num: i + 1,
      stage,
      matchday: m.round || null,
      group: grp,
      date: m.date || null,
      time_local: m.time || null,
      kickoff_utc: kickoffUtc(m.date, m.time),
      team1: m.team1 || null,
      team2: m.team2 || null,
      venue: m.stadium || m.ground || null,
      city: m.city || m.ground || null,
      status: finished ? "finished" : "scheduled",
      score1: finished ? Number(score1) : null,
      score2: finished ? Number(score2) : null,
    };
  });

  // Overlay placar ao vivo — ESPN unofficial (sem auth) é a fonte primária.
  // openfootball depende de commit humano (atrasa); football-data WC é pago.
  let liveCount = 0;
  try {
    const espn = await fetchJson(ESPN_URL);
    const byKey = new Map();
    for (const ev of espn.events || []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const date = (comp.date || ev.date || "").slice(0, 10);
      const home = comp.competitors?.find((c) => c.homeAway === "home")?.team;
      const away = comp.competitors?.find((c) => c.homeAway === "away")?.team;
      if (!date || !home || !away) continue;
      const k = `${date}|${aliasSlug(home.displayName)}|${aliasSlug(away.displayName)}`;
      byKey.set(k, { ev, comp, home, away });
    }
    for (const m of matches) {
      // openfootball list team1 = home, team2 = away (verificado com m001).
      const k = `${m.date}|${aliasSlug(m.team1)}|${aliasSlug(m.team2)}`;
      const hit = byKey.get(k);
      if (!hit) continue;
      const status = hit.ev.status?.type;
      const homeScore = hit.comp.competitors.find((c) => c.homeAway === "home")?.score;
      const awayScore = hit.comp.competitors.find((c) => c.homeAway === "away")?.score;
      const s1 = homeScore != null ? Number(homeScore) : null;
      const s2 = awayScore != null ? Number(awayScore) : null;
      if (status?.completed) {
        m.status = "finished";
        if (s1 != null) m.score1 = s1;
        if (s2 != null) m.score2 = s2;
        liveCount++;
      } else if (status?.state === "in" || /HALF|EXTRA|PENALTY|INTERVAL|END_OF_REGULATION/i.test(status?.name || "")) {
        m.status = "live";
        m.score1 = s1 ?? 0;
        m.score2 = s2 ?? 0;
        m.minute = hit.ev.status?.displayClock || null;
        liveCount++;
      }
    }
  } catch (e) {
    console.warn("[refresh] ESPN overlay skipped:", e.message);
  }

  // Overlay legado (football-data.org) — só se houver token; o free tier não
  // cobre Copa do Mundo, então normalmente é no-op. Mantido como fallback.
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (token) {
    try {
      const live = await fetchJson(FOOTBALL_DATA_URL, {
        "X-Auth-Token": token,
      });
      const byKey = new Map();
      for (const lm of live.matches || []) {
        const d = (lm.utcDate || "").slice(0, 10);
        const k1 = `${d}|${slug(lm.homeTeam?.name)}|${slug(lm.awayTeam?.name)}`;
        byKey.set(k1, lm);
      }
      for (const m of matches) {
        const k = `${m.date}|${slug(m.team1)}|${slug(m.team2)}`;
        const lm = byKey.get(k);
        if (!lm) continue;
        const s = lm.score?.fullTime || {};
        const st = lm.status; // SCHEDULED, LIVE, IN_PLAY, PAUSED, FINISHED
        if (st === "FINISHED") {
          m.status = "finished";
          m.score1 = s.home ?? m.score1;
          m.score2 = s.away ?? m.score2;
          liveCount++;
        } else if (st === "IN_PLAY" || st === "PAUSED" || st === "LIVE") {
          m.status = "live";
          m.score1 = s.home ?? 0;
          m.score2 = s.away ?? 0;
          m.minute = lm.minute ?? null;
          liveCount++;
        }
      }
    } catch (e) {
      console.warn("[refresh] live overlay skipped:", e.message);
    }
  }

  // Derivar grupos.
  const groups = {};
  for (const m of matches) {
    if (!m.group) continue;
    const g = (groups[m.group] ||= { group: m.group, teams: new Set() });
    if (!isPlaceholder(m.team1)) g.teams.add(m.team1);
    if (!isPlaceholder(m.team2)) g.teams.add(m.team2);
  }

  // Tabela (standings) por grupo a partir dos jogos encerrados.
  const standings = {};
  for (const [letter, g] of Object.entries(groups)) {
    const table = {};
    for (const t of g.teams)
      table[t] = { team: t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 };
    for (const m of matches) {
      if (m.group !== letter || m.status !== "finished") continue;
      if (!table[m.team1] || !table[m.team2]) continue;
      const a = table[m.team1];
      const b = table[m.team2];
      a.P++; b.P++;
      a.GF += m.score1; a.GA += m.score2;
      b.GF += m.score2; b.GA += m.score1;
      if (m.score1 > m.score2) { a.W++; a.Pts += 3; b.L++; }
      else if (m.score1 < m.score2) { b.W++; b.Pts += 3; a.L++; }
      else { a.D++; b.D++; a.Pts++; b.Pts++; }
    }
    for (const r of Object.values(table)) r.GD = r.GF - r.GA;
    standings[letter] = Object.values(table).sort(
      (x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF,
    );
  }

  // Seleções e estádios.
  const teamSet = new Set();
  for (const m of matches) {
    if (!isPlaceholder(m.team1)) teamSet.add(m.team1);
    if (!isPlaceholder(m.team2)) teamSet.add(m.team2);
  }
  const teams = [...teamSet].sort().map((name) => {
    const grp = Object.entries(groups).find(([, g]) => g.teams.has(name))?.[0];
    return { name, group: grp || null };
  });

  const venueMap = {};
  for (const m of matches) {
    if (!m.city) continue;
    const v = (venueMap[m.city] ||= { city: m.city, venue: m.venue, matches: 0 });
    v.matches++;
  }

  const out = {
    name: base.name || "World Cup 2026",
    source: "openfootball/worldcup.json + football-data.org",
    updated_at: process.env.REFRESH_NOW || new Date().toISOString(),
    counts: {
      matches: matches.length,
      teams: teams.length,
      groups: Object.keys(groups).length,
      venues: Object.keys(venueMap).length,
      live_overlay: liveCount,
    },
    matches,
    groups: Object.fromEntries(
      Object.entries(groups).map(([k, g]) => [k, [...g.teams].sort()]),
    ),
    standings,
    teams,
    venues: Object.values(venueMap),
  };

  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `[refresh] wrote ${OUT} — ${out.counts.matches} matches, ${out.counts.teams} teams, ${out.counts.groups} groups, live=${liveCount}`,
  );
}

main().catch((e) => {
  console.error("[refresh] FAILED:", e);
  process.exit(1);
});
