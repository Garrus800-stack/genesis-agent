#!/usr/bin/env node
// ============================================================
// GENESIS — Directory Migration Script (v3.12.0)
//
// Restructures src/agent/ from flat 84-file dir to layer subdirs.
// Updates all require() paths automatically.
//
// Usage: node scripts/migrate-dirs.js [--dry-run]
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AGENT_DIR = path.join(ROOT, 'src', 'agent');
const DRY_RUN = process.argv.includes('--dry-run');

// ═══════════════════════════════════════════════════════════
// TARGET STRUCTURE — maps filename → subdirectory
// ═══════════════════════════════════════════════════════════

const DIR_MAP = {
  // core/ — infrastructure, shared by everything
  'EventBus.js': 'core',
  'EventTypes.js': 'core',
  'Container.js': 'core',
  'Constants.js': 'core',
  'Logger.js': 'core',
  'utils.js': 'core',
  'Language.js': 'core',
  'IntervalManager.js': 'core',

  // foundation/ — Phase 1
  'Settings.js': 'foundation',
  'SelfModel.js': 'foundation',
  'ModelBridge.js': 'foundation',
  'PromptEngine.js': 'foundation',
  'Sandbox.js': 'foundation',
  'ConversationMemory.js': 'foundation',
  'EventStore.js': 'foundation',
  'KnowledgeGraph.js': 'foundation',
  'GraphStore.js': 'foundation',
  'StorageService.js': 'foundation',
  'CapabilityGuard.js': 'foundation',
  'ASTDiff.js': 'foundation',
  'WorldState.js': 'foundation',
  'DesktopPerception.js': 'foundation',
  'EmbeddingService.js': 'foundation',
  'UncertaintyGuard.js': 'foundation',
  'WebFetcher.js': 'foundation',

  // intelligence/ — Phase 2
  'IntentRouter.js': 'intelligence',
  'ToolRegistry.js': 'intelligence',
  'PromptBuilder.js': 'intelligence',
  'ContextManager.js': 'intelligence',
  'ReasoningEngine.js': 'intelligence',
  'CodeAnalyzer.js': 'intelligence',
  'CircuitBreaker.js': 'intelligence',
  'VerificationEngine.js': 'intelligence',
  'WorkerPool.js': 'intelligence',
  'GenericWorker.js': 'intelligence',

  // capabilities/ — Phase 3
  'ShellAgent.js': 'capabilities',
  'SkillManager.js': 'capabilities',
  'FileProcessor.js': 'capabilities',
  'HotReloader.js': 'capabilities',
  'McpClient.js': 'capabilities',
  'McpServer.js': 'capabilities',
  'McpTransport.js': 'capabilities',
  'ToolBootstrap.js': 'capabilities',
  'CloneFactory.js': 'capabilities',

  // planning/ — Phase 4
  'GoalStack.js': 'planning',
  'Anticipator.js': 'planning',
  'SolutionAccumulator.js': 'planning',
  'SelfOptimizer.js': 'planning',
  'MetaLearning.js': 'planning',
  'Reflector.js': 'planning',

  // hexagonal/ — Phase 5
  'ChatOrchestrator.js': 'hexagonal',
  'SelfModificationPipeline.js': 'hexagonal',
  'CommandHandlers.js': 'hexagonal',
  'UnifiedMemory.js': 'hexagonal',
  'LearningService.js': 'hexagonal',
  'EpisodicMemory.js': 'hexagonal',
  'PeerNetwork.js': 'hexagonal',
  'TaskDelegation.js': 'hexagonal',

  // autonomy/ — Phase 6
  'AutonomousDaemon.js': 'autonomy',
  'IdleMind.js': 'autonomy',
  'HealthMonitor.js': 'autonomy',
  'CognitiveMonitor.js': 'autonomy',

  // organism/ — Phase 7
  'EmotionalState.js': 'organism',
  'Homeostasis.js': 'organism',
  'NeedsSystem.js': 'organism',

  // revolution/ — Phase 8
  'AgentLoop.js': 'revolution',
  'AgentLoopPlanner.js': 'revolution',
  'AgentLoopSteps.js': 'revolution',
  'AgentLoopDelegate.js': 'revolution',
  'NativeToolUse.js': 'revolution',
  'VectorMemory.js': 'revolution',
  'SessionPersistence.js': 'revolution',
  'MultiFileRefactor.js': 'revolution',
  'FormalPlanner.js': 'revolution',
  'HTNPlanner.js': 'revolution',
  'ModelRouter.js': 'revolution',
  'ModuleRegistry.js': 'revolution',

  // root stays — orchestration
  'ContainerManifest.js': null, // stays in agent/
  'AgentCore.js': null,         // stays in agent/
};

// ═══════════════════════════════════════════════════════════
// STEP 1: Compute reverse map (module name → subdir)
// ═══════════════════════════════════════════════════════════

function getModuleName(filename) {
  return filename.replace(/\.js$/, '');
}

// Build: moduleName → subdir (null = stays at agent/ root)
const moduleToDir = {};
for (const [file, dir] of Object.entries(DIR_MAP)) {
  moduleToDir[getModuleName(file)] = dir;
}

// ═══════════════════════════════════════════════════════════
// STEP 2: Compute new require paths
// ═══════════════════════════════════════════════════════════

/**
 * Given a source file's subdirectory and a target module name,
 * compute the relative require path.
 */
function computeRequirePath(sourceDir, targetModuleName) {
  const targetDir = moduleToDir[targetModuleName];

  // Special: ports stay where they are
  if (targetModuleName.startsWith('ports/')) return './' + targetModuleName;

  if (targetDir === undefined) {
    // Unknown module — leave as-is
    return null;
  }

  if (sourceDir === targetDir) {
    // Same directory
    return './' + targetModuleName;
  }

  if (sourceDir === null && targetDir === null) {
    // Both at root
    return './' + targetModuleName;
  }

  if (sourceDir === null && targetDir !== null) {
    // Source at root, target in subdir
    return './' + targetDir + '/' + targetModuleName;
  }

  if (sourceDir !== null && targetDir === null) {
    // Source in subdir, target at root
    return '../' + targetModuleName;
  }

  // Both in different subdirs
  return '../' + targetDir + '/' + targetModuleName;
}

// ═══════════════════════════════════════════════════════════
// STEP 3: Process files
// ═══════════════════════════════════════════════════════════

const stats = { moved: 0, requiresUpdated: 0, errors: [] };

// Create subdirectories
const subdirs = new Set(Object.values(DIR_MAP).filter(Boolean));
for (const dir of subdirs) {
  const full = path.join(AGENT_DIR, dir);
  if (!fs.existsSync(full)) {
    if (!DRY_RUN) fs.mkdirSync(full, { recursive: true });
    console.log(`  mkdir ${dir}/`);
  }
}

// Process each mapped file
for (const [filename, targetDir] of Object.entries(DIR_MAP)) {
  const sourcePath = path.join(AGENT_DIR, filename);
  if (!fs.existsSync(sourcePath)) {
    console.log(`  SKIP ${filename} (not found)`);
    continue;
  }

  let content = fs.readFileSync(sourcePath, 'utf-8');
  let updated = 0;

  // Update require paths
  content = content.replace(
    /require\('\.\/([^']+)'\)/g,
    (match, requiredModule) => {
      // Handle sub-paths like './ports/index'
      if (requiredModule.startsWith('ports/')) return match;

      // Handle './AgentLoopPlanner' etc.
      const moduleName = requiredModule.replace(/\.js$/, '');
      const newPath = computeRequirePath(targetDir, moduleName);

      if (newPath === null) return match; // Unknown, leave as-is
      if (newPath === './' + moduleName) return match; // No change needed

      updated++;
      return `require('${newPath}')`;
    }
  );

  // Write updated content
  if (targetDir) {
    const destPath = path.join(AGENT_DIR, targetDir, filename);
    if (!DRY_RUN) {
      fs.writeFileSync(destPath, content, 'utf-8');
      fs.unlinkSync(sourcePath);
    }
    stats.moved++;
    if (updated > 0) stats.requiresUpdated += updated;
    console.log(`  ${filename} → ${targetDir}/${filename}${updated > 0 ? ` (${updated} requires updated)` : ''}`);
  } else {
    // Stays at root — still update requires
    if (updated > 0) {
      if (!DRY_RUN) fs.writeFileSync(sourcePath, content, 'utf-8');
      stats.requiresUpdated += updated;
      console.log(`  ${filename} (root, ${updated} requires updated)`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 4: Update ContainerManifest.js R() helper
// ═══════════════════════════════════════════════════════════

const manifestPath = path.join(AGENT_DIR, 'ContainerManifest.js');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf-8');

  // Replace the R() helper with a directory-aware version
  const oldR = `const R = (mod) => require(\`./\${mod}\`);`;
  const newR = `// v3.12.0: Directory-aware module resolver
  const _dirMap = ${JSON.stringify(
    Object.fromEntries(
      Object.entries(DIR_MAP)
        .filter(([, dir]) => dir !== null)
        .map(([file, dir]) => [getModuleName(file), dir])
    ), null, 4
  ).replace(/\n/g, '\n  ')};
  const R = (mod) => {
    const dir = _dirMap[mod];
    return dir ? require(\`./\${dir}/\${mod}\`) : require(\`./\${mod}\`);
  };`;

  if (manifest.includes(oldR)) {
    manifest = manifest.replace(oldR, newR);
    if (!DRY_RUN) fs.writeFileSync(manifestPath, manifest, 'utf-8');
    console.log('  ContainerManifest.js → R() updated with directory resolver');
  } else {
    console.log('  WARN: Could not find R() pattern in ContainerManifest.js');
  }
}

// ═══════════════════════════════════════════════════════════
// STEP 5: Update AgentCore.js requires
// ═══════════════════════════════════════════════════════════

const corePath = path.join(AGENT_DIR, 'AgentCore.js');
if (fs.existsSync(corePath)) {
  let core = fs.readFileSync(corePath, 'utf-8');
  let coreUpdated = 0;

  core = core.replace(
    /require\('\.\/([^']+)'\)/g,
    (match, requiredModule) => {
      if (requiredModule.startsWith('ports/')) return match;
      const moduleName = requiredModule.replace(/\.js$/, '');
      const newPath = computeRequirePath(null, moduleName); // AgentCore is at root
      if (newPath === null || newPath === './' + moduleName) return match;
      coreUpdated++;
      return `require('${newPath}')`;
    }
  );

  if (coreUpdated > 0) {
    if (!DRY_RUN) fs.writeFileSync(corePath, core, 'utf-8');
    stats.requiresUpdated += coreUpdated;
    console.log(`  AgentCore.js (${coreUpdated} requires updated)`);
  }
}

// Handle ports/index.js — needs path update for LLMPort etc requiring parent modules
// ports/ stays as-is since it only requires siblings

console.log(`\n=== Migration ${DRY_RUN ? '(DRY RUN)' : 'COMPLETE'} ===`);
console.log(`  Files moved: ${stats.moved}`);
console.log(`  Requires updated: ${stats.requiresUpdated}`);
console.log(`  Subdirectories: ${subdirs.size}`);
if (stats.errors.length > 0) {
  console.log(`  Errors: ${stats.errors.length}`);
  for (const e of stats.errors) console.log(`    - ${e}`);
}
