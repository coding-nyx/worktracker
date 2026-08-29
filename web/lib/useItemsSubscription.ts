/**
 * Live `onSnapshot` subscription to the work items collection.
 * Used by the Kanban view for instant updates. Falls back to
 * empty + error if Firestore isn't configured (the page then
 * renders the REST snapshot as a graceful degradation).
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy, type QueryConstraint } from 'firebase/firestore';
import type { WorkItem } from '@worktracker/types';
import { getFirebaseDb } from './firebase';

interface UseItemsSubscriptionOptions {
  source?: string;
}

export function useItemsSubscription({ source }: UseItemsSubscriptionOptions = {}): {
  items: WorkItem[];
  error: string | null;
} {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Skip if Firebase isn't configured (the page falls back
    // to REST).
    if (!process.env.NEXT_PUBLIC_FIREBASE_API_KEY) {
      setError('firebase not configured');
      return;
    }
    const db = getFirebaseDb();
    const constraints: QueryConstraint[] = [orderBy('updated_at', 'desc')];
    if (source) constraints.unshift(where('source', '==', source));
    const ref = query(collection(db, 'work_items'), ...constraints);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const next: WorkItem[] = snap.docs.map((d) => d.data() as WorkItem);
        setItems(next);
        setError(null);
      },
      (err) => {
        setError(err.message);
      },
    );
    return () => unsub();
  }, [source]);

  return { items, error };
}
