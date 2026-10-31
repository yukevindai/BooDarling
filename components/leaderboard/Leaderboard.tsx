"use client";
import { useLeaderboard } from "@/lib/leaderboard/useLeaderboard";
import { boardScore, type Entry } from "@/lib/leaderboard/store";
import type { JudgeMode } from "@/lib/types";
import s from "./Leaderboard.module.css";

/** Board titles and score labels per judging mode ("fairest" → costume, "scariest" → scare). */
export const BOARDS: Record<JudgeMode, { title: string; short: string; score: string }> = {
  costume: { title: "Most Cruella", short: "Fairest", score: "Aura" },
  scare: { title: "Most Terrifying", short: "Scariest", score: "Scare" },
};

/** Slim strip for the top of the page: the top few of each board. */
export function LeaderboardRibbon({ limit = 3 }: { limit?: number }) {
  const costume = useLeaderboard("costume").slice(0, limit);
  const scare = useLeaderboard("scare").slice(0, limit);
  return (
    <aside className={s.ribbon} aria-label="Leaderboards">
      {costume.length === 0 && scare.length === 0 ? (
        <>
          <span className={s.ribbonTitle}>Top Darlings</span>
          <span className={s.empty}>No darlings yet. Be the first.</span>
        </>
      ) : (
        <>
          <RibbonGroup mode="costume" entries={costume} />
          <RibbonGroup mode="scare" entries={scare} />
        </>
      )}
    </aside>
  );
}

function RibbonGroup({ mode, entries }: { mode: JudgeMode; entries: Entry[] }) {
  return (
    <>
      <span className={s.ribbonTitle}>{BOARDS[mode].short}</span>
      {entries.length === 0 ? (
        <span className={s.empty}>Nobody yet.</span>
      ) : (
        <ol className={s.ribbonList}>
          {entries.map((e, i) => (
            <li key={e.id}>
              <b>{medal(i)}</b> {e.name} <span className={s.pts}>{boardScore(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** Full board for one mode, shown in the mirror after a visitor signs in; highlights their row. */
export function LeaderboardBoard({ mode, highlightId, limit = 8 }: { mode: JudgeMode; highlightId?: string; limit?: number }) {
  const all = useLeaderboard(mode);
  const top = all.slice(0, limit);
  const myRank = highlightId ? all.findIndex((e) => e.id === highlightId) : -1;
  const me = myRank >= limit ? all[myRank] : null;
  const { title, score } = BOARDS[mode];

  return (
    <div className={s.board}>
      <h2 className={`${s.boardTitle} glitch`} data-text={title}>
        {title}
      </h2>
      <table className={s.table}>
        <thead>
          <tr>
            <th>#</th>
            <th className={s.name}>Darling</th>
            <th>{score}</th>
          </tr>
        </thead>
        <tbody>
          {top.map((e, i) => (
            <Row key={e.id} e={e} rank={i} mine={e.id === highlightId} />
          ))}
          {me && (
            <>
              <tr className={s.gap}>
                <td colSpan={3}>⋮</td>
              </tr>
              <Row e={me} rank={myRank} mine />
            </>
          )}
        </tbody>
      </table>
      {myRank >= 0 && <p className={s.you}>You placed #{myRank + 1} of {all.length}, darling.</p>}
    </div>
  );
}

function Row({ e, rank, mine }: { e: Entry; rank: number; mine: boolean }) {
  return (
    <tr className={mine ? s.mine : undefined}>
      <td>{medal(rank)}</td>
      <td className={s.name}>{e.name}</td>
      <td className={s.total}>{boardScore(e)}</td>
    </tr>
  );
}

function medal(i: number) {
  return ["👑", "🥈", "🥉"][i] ?? String(i + 1);
}
