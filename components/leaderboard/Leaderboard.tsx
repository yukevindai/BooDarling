"use client";
import { useLeaderboard } from "@/lib/leaderboard/useLeaderboard";
import type { Entry } from "@/lib/leaderboard/store";
import s from "./Leaderboard.module.css";

/** Slim "Top Darlings" strip for the top of the page. */
export function LeaderboardRibbon({ limit = 5 }: { limit?: number }) {
  const entries = useLeaderboard().slice(0, limit);
  return (
    <aside className={s.ribbon} aria-label="Leaderboard">
      <span className={s.ribbonTitle}>Top Darlings</span>
      {entries.length === 0 ? (
        <span className={s.empty}>No darlings yet. Be the first.</span>
      ) : (
        <ol className={s.ribbonList}>
          {entries.map((e, i) => (
            <li key={e.id}>
              <b>{medal(i)}</b> {e.name} <span className={s.pts}>{e.total}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

/** Full board shown in the mirror after a visitor signs in; highlights their row. */
export function LeaderboardBoard({ highlightId, limit = 8 }: { highlightId?: string; limit?: number }) {
  const all = useLeaderboard();
  const top = all.slice(0, limit);
  const myRank = highlightId ? all.findIndex((e) => e.id === highlightId) : -1;
  const me = myRank >= limit ? all[myRank] : null;

  return (
    <div className={s.board}>
      <h2 className={`${s.boardTitle} glitch`} data-text="The Baroness's Favourites">
        The Baroness&apos;s Favourites
      </h2>
      <table className={s.table}>
        <thead>
          <tr>
            <th>#</th>
            <th className={s.name}>Darling</th>
            <th>Aura</th>
            <th>Scare</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {top.map((e, i) => (
            <Row key={e.id} e={e} rank={i} mine={e.id === highlightId} />
          ))}
          {me && (
            <>
              <tr className={s.gap}>
                <td colSpan={5}>⋮</td>
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
      <td>{e.aura}</td>
      <td>{e.scare ?? "–"}</td>
      <td className={s.total}>{e.total}</td>
    </tr>
  );
}

function medal(i: number) {
  return ["👑", "🥈", "🥉"][i] ?? String(i + 1);
}
