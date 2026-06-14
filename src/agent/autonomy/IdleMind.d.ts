// Auto-generated type declarations for prototype-delegated methods.
// These methods are attached via Object.assign at module load.
// Declared here so TypeScript sees them without affecting c8 coverage.

export class IdleMind {
  _writeJournalEntry(...args: any[]): any;
  _tidy(...args: any[]): any;
  _reflect(...args: any[]): Promise<any>;
  _plan(...args: any[]): Promise<any>;
  _explore(...args: any[]): Promise<any>;
  _exploreMcp(...args: any[]): Promise<any>;
  _ideate(...args: any[]): Promise<any>;
  _dream(...args: any[]): Promise<any>;
  _consolidateMemory(...args: any[]): Promise<any>;
  _calibrate(...args: any[]): Promise<any>;
  _journal(activity: string, content: any): void;
  readJournal(limit?: number): any[];
  _snapshotEmotion(): any;
  _rotateJournalIfNeeded(): void;
  getPlans(): any[];
  updatePlanStatus(planId: string, status: string): void;
  _loadPlans(): any[];
  _savePlans(): void;
  _savePlansSync(): void;
  _loadProposals(): any[];
  _saveProposals(): void;
  getStatus(): any;
  getRuntimeSnapshot(): any;
  _linkGoalToPlan(goalId: any, planId: any): void;
  _onGoalTerminal(data: any, status: string): void;
  _subscribeGoalTerminal(): void;
}
