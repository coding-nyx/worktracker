/**
 * Small read-only helpers for the AI brain's system prompt.
 * Kept separate from the route so the prompt can be tested
 * without spinning up a full Fastify request.
 */

import type { Board } from '@worktracker/types';
import { getDb } from '../firestore.js';

export async function listBoardsForPrompt(): Promise<Board[]> {
  try {
    const snap = await getDb().collection('boards').orderBy('name').get();
    return snap.docs.map((d) => d.data() as Board);
  } catch {
    return [];
  }
}
