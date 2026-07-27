import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  holdEditingThreadOutboxMessage,
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
 * The visible pending-queue for the active thread, rendered just above the
 * composer. Each queued message is editable in place and removable; the drain
 * (useThreadOutboxDrain) sends the head automatically once the thread settles.
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
    <div className="mx-auto mb-1.5 w-full max-w-3xl">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Queued {queue.length === 1 ? "message" : "messages"} · {queue.length}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {queue.map((message) => (
          <QueuedMessageRow key={message.messageId} message={message} />
        ))}
      </ul>
    </div>
  );
}

function QueuedMessageRow({ message }: { message: QueuedThreadMessage }) {
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

  if (isEditing) {
    return (
      <li className="rounded-lg border border-border/60 bg-card/70 p-2">
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
        "group flex items-start gap-2 rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-sm",
        busy && "opacity-50",
      )}
    >
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90 line-clamp-3">
        {message.text}
      </p>
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <Button
          aria-label="Edit queued message"
          disabled={busy}
          onClick={beginEditing}
          size="icon-sm"
          variant="ghost"
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          aria-label="Remove queued message"
          disabled={busy}
          onClick={() => void remove()}
          size="icon-sm"
          variant="ghost"
        >
          {busy ? <XIcon className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
        </Button>
      </div>
    </li>
  );
}
