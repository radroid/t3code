import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  holdEditingThreadOutboxMessage,
  moveThreadOutboxMessage,
  releaseEditingThreadOutboxMessage,
  removeThreadOutboxMessage,
  updateThreadOutboxMessage,
  useThreadOutboxQueue,
} from "~/outbox/threadOutbox";
import type { QueuedThreadMessage } from "~/outbox/threadOutbox.logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/**
 * The visible pending-queue for the active thread. It renders *inside* the
 * composer's glass host, so it is deliberately chrome-less: one dense row per
 * message, separated from the prompt by a single hairline. Boxing each row
 * would put a second bordered container inside the composer's own 22px outline.
 *
 * Each queued message is editable in place, removable, and can be moved within
 * the queue; the drain (useThreadOutboxDrain) sends the head automatically once
 * the thread settles.
 */
export function ThreadOutboxQueueList({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const queue = useThreadOutboxQueue(environmentId, threadId);

  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="border-border/40 border-b px-2.5 pt-2.5 pb-1.5 sm:px-3 sm:pt-3">
      <div className="flex items-baseline gap-1.5 px-1 pb-1 text-[11px] text-muted-foreground/70 leading-none">
        <span className="font-medium">
          {queue.length} queued {queue.length === 1 ? "message" : "messages"}
        </span>
        <span aria-hidden="true">·</span>
        {/* The contract, which was previously nowhere in the UI. Phrased to hold
            for both reasons a message queues: a running turn, and a dropped
            connection. */}
        <span className="truncate">Sends automatically when the chat is ready</span>
      </div>
      {/* Capped so a long queue scrolls instead of pushing the composer up the
          viewport. */}
      <ul className="flex max-h-40 flex-col overflow-y-auto overscroll-contain">
        {queue.map((message, index) => (
          <QueuedMessageRow
            key={message.messageId}
            canMoveDown={index < queue.length - 1}
            canMoveUp={index > 0}
            message={message}
            position={index + 1}
          />
        ))}
      </ul>
    </div>
  );
}

function QueuedMessageRow({
  canMoveDown,
  canMoveUp,
  message,
  position,
}: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  message: QueuedThreadMessage;
  position: number;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const messageIdRef = useRef<MessageId>(message.messageId);

  // Keep the local draft aligned with external updates while not editing.
  useEffect(() => {
    if (!isEditing) {
      setDraft(message.text);
    }
  }, [isEditing, message.text]);

  // Release the editing hold if the row unmounts mid-edit (e.g. delivered).
  useEffect(() => {
    const id = messageIdRef.current;
    return () => {
      releaseEditingThreadOutboxMessage(id);
    };
  }, []);

  const beginEditing = useCallback(() => {
    holdEditingThreadOutboxMessage(message.messageId);
    setDraft(message.text);
    setIsEditing(true);
  }, [message.messageId, message.text]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setDraft(message.text);
    releaseEditingThreadOutboxMessage(message.messageId);
  }, [message.messageId, message.text]);

  const saveEditing = useCallback(async () => {
    const nextText = draft.trim();
    if (nextText.length === 0 || nextText === message.text) {
      cancelEditing();
      return;
    }
    setBusy(true);
    try {
      await updateThreadOutboxMessage({ ...message, text: nextText });
    } finally {
      setBusy(false);
      setIsEditing(false);
      releaseEditingThreadOutboxMessage(message.messageId);
    }
  }, [cancelEditing, draft, message]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await removeThreadOutboxMessage(message);
    } finally {
      setBusy(false);
    }
  }, [message]);

  const move = useCallback(
    async (direction: "up" | "down") => {
      setBusy(true);
      try {
        await moveThreadOutboxMessage(message, direction);
      } finally {
        setBusy(false);
      }
    },
    [message],
  );

  if (isEditing) {
    return (
      <li className="py-1">
        <Textarea
          aria-label="Edit queued message"
          autoFocus
          className="min-h-16"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void saveEditing();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
          size="sm"
          value={draft}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <Button disabled={busy} onClick={cancelEditing} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy || draft.trim().length === 0}
            onClick={() => void saveEditing()}
            size="sm"
          >
            <CheckIcon className="size-3.5" />
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent/40",
        busy && "opacity-50",
      )}
    >
      <span
        aria-hidden="true"
        className="w-3 shrink-0 text-right text-[11px] text-muted-foreground/50 tabular-nums"
      >
        {position}
      </span>
      {/* One line, truncated: a queued message is a reminder of what is coming,
          not something to read in full. Editing shows the whole text. */}
      <p className="min-w-0 flex-1 truncate text-foreground/80">{message.text}</p>
      {/* Revealed on hover, on keyboard focus anywhere in the row, and always on
          touch devices, which have no hover state to reveal them. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        <Button
          aria-label={`Move queued message ${position} up`}
          disabled={busy || !canMoveUp}
          onClick={() => void move("up")}
          size="icon-xs"
          variant="ghost"
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={`Move queued message ${position} down`}
          disabled={busy || !canMoveDown}
          onClick={() => void move("down")}
          size="icon-xs"
          variant="ghost"
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <Button
          aria-label="Edit queued message"
          disabled={busy}
          onClick={beginEditing}
          size="icon-xs"
          variant="ghost"
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          aria-label="Remove queued message"
          disabled={busy}
          onClick={() => void remove()}
          size="icon-xs"
          variant="ghost"
        >
          {busy ? <XIcon className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
        </Button>
      </div>
    </li>
  );
}
