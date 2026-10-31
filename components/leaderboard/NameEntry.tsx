"use client";
/**
 * "Sign the guest book": the visitor types a name for the leaderboard.
 * Never traps the flow: after `timeoutMs` the score is saved as Mystery Guest.
 */
import { useEffect, useRef, useState } from "react";
import { ANONYMOUS } from "@/lib/leaderboard/store";
import type { JudgeMode } from "@/lib/types";
import { BOARDS } from "./Leaderboard";
import s from "./Leaderboard.module.css";

type Props = {
  /** Which board the score goes on. */
  mode: JudgeMode;
  /** Aura (costume) or Scare Score (scare). */
  score: number;
  /** Verdict words shown with the score (verdictWord / scareVerdict). */
  verdict?: string;
  onSubmit: (name: string) => void;
  timeoutMs?: number;
};

export default function NameEntry({ mode, score, verdict, onSubmit, timeoutMs = 25000 }: Props) {
  const [name, setName] = useState("");
  const [left, setLeft] = useState(Math.ceil(timeoutMs / 1000));
  const sent = useRef(false);
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const nameRef = useRef(name);
  nameRef.current = name;

  const submit = (value: string) => {
    if (sent.current) return;
    sent.current = true;
    submitRef.current(value);
  };

  // Countdown; typing resets it so slow typists aren't cut off.
  useEffect(() => {
    const id = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) {
          clearInterval(id);
          submit(nameRef.current || ANONYMOUS);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <form
      className={s.entry}
      onSubmit={(e) => {
        e.preventDefault();
        submit(name);
      }}
    >
      <p className={s.entryTitle}>Sign the Baroness&apos;s guest book</p>
      <p className={s.entryScores}>
        {BOARDS[mode].score} <b>{score}</b>
        {verdict && <> · {verdict}</>}
        <br />
        for the <b>{BOARDS[mode].title}</b> board
      </p>
      <input
        className={s.input}
        autoFocus
        maxLength={20}
        placeholder="Your name, darling"
        aria-label="Your name for the leaderboard"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setLeft(Math.ceil(timeoutMs / 1000));
        }}
      />
      <div className={s.entryActions}>
        <button className="btn" type="submit">
          Add me to the board
        </button>
        <button className={s.skip} type="button" onClick={() => submit(ANONYMOUS)}>
          Stay anonymous
        </button>
      </div>
      <p className={s.timer}>Saving as {ANONYMOUS} in {left}s</p>
    </form>
  );
}
