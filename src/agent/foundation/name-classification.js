'use strict';
/**
 * name-classification — shared name-vs-role/state classifier (v7.9.28, A1).
 *
 * Extracted from LearningService so BOTH the forward-routing classifier and the
 * one-time ConversationMemory store-migration use the SAME negative set. The set
 * itself is unchanged — only relocated, not reinvented.
 */
const NAME_NEGATIVE = new Set([
  // roles / occupations (DE)
  'entwickler', 'entwicklerin', 'programmierer', 'programmiererin', 'designer',
  'informatiker', 'student', 'studentin', 'schueler', 'schülerin', 'lehrer',
  'lehrerin', 'ingenieur', 'arzt', 'ärztin', 'aerztin', 'anwalt', 'manager',
  'berater', 'admin', 'administrator', 'nutzer', 'benutzer', 'mensch', 'mann',
  'frau', 'kind', 'vater', 'mutter', 'freund', 'freundin', 'chef', 'chefin',
  'mitarbeiter', 'kunde', 'gast', 'autor', 'künstler', 'kuenstler', 'forscher',
  // roles / occupations (EN)
  'developer', 'programmer', 'engineer', 'scientist', 'doctor', 'lawyer',
  'teacher', 'pupil', 'consultant', 'user', 'human', 'person', 'man', 'woman',
  'child', 'father', 'mother', 'friend', 'boss', 'employee', 'customer', 'guest',
  'author', 'artist', 'researcher', 'founder', 'dev',
  // transient states (DE)
  'müde', 'muede', 'krank', 'gesund', 'traurig', 'glücklich', 'gluecklich',
  'hungrig', 'durstig', 'wach', 'fertig', 'bereit', 'beschäftigt', 'gestresst',
  'entspannt', 'neugierig', 'zufrieden', 'sicher', 'unsicher', 'da', 'zurück',
  'zurueck', 'online', 'offline', 'weg',
  // transient states (EN)
  'tired', 'sick', 'ill', 'healthy', 'sad', 'happy', 'hungry', 'thirsty',
  'awake', 'ready', 'busy', 'stressed', 'relaxed', 'curious', 'fine', 'okay',
  'back', 'online', 'offline', 'away', 'done',
]);

/**
 * A captured value is "likely a name" when it is a single short token that is
 * not a known role/state word. Used to decide whether "ich bin X" puts X in
 * user.name (name) or user.role (role/state like "Entwickler", "müde").
 */
function isLikelyName(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 3) return false;            // too short to be a name
  if (/\s/.test(v)) return false;            // multi-word -> not a bare name
  if (NAME_NEGATIVE.has(v.toLowerCase())) return false;
  return true;
}

module.exports = { NAME_NEGATIVE, isLikelyName };
