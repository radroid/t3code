# Loops

A loop keeps one thread working while you are away, and collects everything it needs from you in
one place so that opening the thread in the morning answers a single question: **what do you need
from me?**

T3 Code does not replace the agent's own pacing. Claude schedules its own wake-ups and is good at
it. What it cannot do is survive a restart — a wake it scheduled lives inside the running session,
so if the app restarts or the session stops, that wake disappears with no record it ever existed.
A loop is T3 Code's written-down copy: it stands by while the agent is pacing itself, covers a
wake that never lands, and enforces the bounds you set.

## Arm a loop

Open the thread you are about to walk away from. Above the composer there is a loop control; open
it and set:

- **What it is working on.** One line. It is restated to the agent at every check-in, because a
  long run compacts and a contract taught once is gone a few hours later.
- **Check-ins.** How many times the loop may restart the thread if it goes quiet. Between 1 and 20.
  There is no unlimited option, deliberately.
- **Stop by.** A wall-clock time, in your timezone. Every run has one; a loop with no deadline is
  refused rather than given a default.

Arming pins the thread so it stays at the top of your sidebar. Disarming removes the pin again —
unless the thread was already pinned when you armed it, in which case your pin is left alone.

A snoozed thread cannot be armed. Arming would cancel the snooze as a side effect, and that is your
decision to make, not the loop's. Unsnooze it first.

## What the loop actually does

Between check-ins the loop watches and spends nothing. It only nudges the thread when **all** of
these are true:

- the thread has been completely silent for longer than the check-in threshold (a longer threshold
  applies while a turn still looks busy, so a forty-minute test suite is not mistaken for a stall);
- there is no wake the agent scheduled for itself still pending inside the run's deadline;
- nothing is waiting on you — an approval, a question, or a plan you have not accepted;
- there is no usage limit in force.

Each of those is a reason to **stand down**, not to stop. Standing down costs no check-in, and the
run keeps its budget and its deadline.

On a healthy, self-pacing thread a loop should almost never fire. That is what a correct one looks
like.

## The console

The loop control above the composer expands into the console. It has five parts, and which ones
appear depends on what happened overnight.

**Stopped on these.** Questions and approvals the agent could not get past. These are answered in
the composer, where the question already is — the console names them and points you at it. The
loop resumes on its own once you answer.

**Answer when you can.** Questions the agent raised _without_ stopping, so it could keep working
around them. Answer them here, at whatever time suits you. An answer given while the thread is idle
is **banked**: the console says so, and the next check-in restates it to the agent. Answered and
"the agent has been told" are shown as different things, because they are.

**Never answered.** Questions that were open when the session ended and were closed by the session
ending rather than by an answer. Nothing else in the app records that these existed.

**State and bounds.** Which state the loop is in, how much of the budget is gone, when it stops, and
the next wake the agent scheduled for itself.

**Check-ins.** One line per time the loop woke the thread, with what moved. These are observed
facts, never the agent's own account of its night.

The console is an overlay: the transcript stays what you land on, and the console is one click
above it.

## Deferred questions need agent browser access

The "answer when you can" channel reaches the agent over the same per-thread connection that backs
the preview browser tools. If **Settings → Integrations → Agent browser access** is off, the agent
has no way to raise a question without stopping and waiting for you.

The console says so by name when that happens. An empty list there does not mean the agent had
nothing to ask.

## How a run ends

- **Finished.** The agent said it was done — either by writing a `.coil/loop-done` file in the
  project (one line saying why is enough) or by telling the loop directly. The file is the primary
  contract: it works from a plain terminal.
- **Out of rope.** The budget or the deadline ran out. This is shown differently from "finished",
  on purpose. The agent never said it was done; it was stopped.
- **Stalled.** Two check-ins in a row moved nothing, so the loop stopped spending.
- **Handed back.** You sent a message, or disarmed it. Taking over is not a budget reset: the run
  keeps the check-ins it already spent.

All four are sticky. A stopped loop stays stopped until you deliberately give it another run, which
clears the budget and starts fresh.

When a run ends while the agent still has wakes of its own pending, T3 Code ends the session too.
Those wakes live inside the session, and a bound that cannot stop the agent is not a bound. It is a
blunt instrument, and it will end any other background work in that session with it.

## Settings → Loops

**Let threads run as loops** is the master switch, and it is a **guard, not a lifecycle**. With it
off, nothing fires: every armed loop reports that it is standing down, and keeps its budget, its
deadline and its arm. Nothing is disarmed and nothing is stopped. Switch it back on and the same
loops carry on where they were.

The same rule covers **Loops at once**. Lowering it below the number currently armed is allowed; the
excess stand down rather than being disarmed.

The rest of the page is defaults — the thresholds and the budget a newly armed loop starts from, and
how far ahead its deadline is set. They seed the form when you arm a loop; changing them never
alters a run already in flight.

**Armed right now** lists every loop across every project, with its state and what it has spent, so
"did any of my runs give up overnight?" is one page rather than three threads. Arming is not on this
page: it is a decision you make as you walk away from a thread.
