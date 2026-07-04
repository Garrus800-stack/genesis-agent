## [7.9.28]

This release follows a series of real Windows field runs and closes the gaps they exposed in how a code-capable model drives the agent from chat. The model could reason but not reliably act on the host: it reached for a shell tool that only echoed the command, called a Unix utility absent on the machine, mishandled OneDrive-redirected and space-or-paren folder names, emitted tool calls in a syntax the parser did not read, or announced an action and then stalled waiting for confirmation. Filesystem operations are now deterministic — resolved and executed straight through the filesystem, with the model reserved for the summary text alone — the model's tool calls execute whatever form it emits them in, and multi-step work runs to completion. Alongside, a cluster of routing defects that sent file commands to the model instead of the deterministic handlers is corrected, and the same operations now work in English as well as German. Every change is against the field traces and at the root; none touches the kernel or the gate set.

### Deterministic file view, create, write, and summary

Listing a folder, reading a file, creating one, and writing into one previously depended on the chat model, which on the host produced a shell command that was returned verbatim, invoked a utility that does not exist there, or quoted a path with spaces and parentheses incorrectly. Each is now a bounded operation that touches the filesystem directly: a folder listing distinguishes a count query from a name query, a file read returns the real content and reports an empty file as empty rather than inventing one, and a file create writes exactly one named file while protecting an existing non-empty file. A file summary resolves and reads the whole document and makes a single model call with a strict instruction to summarise it completely and directly, which removes the announce-and-wait and partial-summary behaviour of the tool loop; any failure falls back to the prior content-attach path. These handlers are a distinct concern, so they live in their own composition unit rather than enlarging the shell handler.

### Named targets resolve across common locations

A folder or file named without a location — the common case in chat — now resolves by searching the project root, the Desktop and Documents and Downloads folders including their OneDrive-redirected forms, the other standard user folders, and the drive roots, case- and extension-insensitively. This makes opening or listing a folder by name succeed wherever it lives, and it stops an unknown name from being launched as an application: a name that resolves to a folder is opened as one, and only a genuine application request reaches the launcher. The command parsing that feeds this was hardened so that an article, a trailing directory word, a leading preamble, or a common misspelling of the location word no longer displaces the actual name.

### File commands reach their handlers

Several phrasings were being answered by the model instead of the deterministic handlers. A file-view request phrased as a question was caught by the conversational question gate and sent to the model; a capability-framed request to summarise, read, or write was treated as small talk because those verbs were absent from the action-verb set; and a file whose name collided with a code-generation keyword was captured by the code-generation guard. Each is now recognised as the command it is and routed to its handler, in both German and English, while genuine questions and genuine code-generation requests are unaffected.

### Tool calls execute in whatever form the model emits

Different models express a tool call differently, and only one form was read before, so the others were shown as raw markup and never ran — the model got no result and looped. The parser is now a normaliser: it reads the tool name from `name`, `tool`, or `function` and the arguments from `input`, `arguments`, `args`, or `parameters`, so the XML function-calls form, the attribute-tag form, and JSON forms that carry a tool marker all execute, while an ordinary JSON object in prose is left untouched. The streaming filter was generalised the same way, so none of these forms appears as raw markup in the chat while it streams.

### Trusted operations run, untrusted ones stay gated

A path or command the user names directly in chat is treated as trusted and lifts the sandbox's scope barrier — which is what lets a folder or file named in chat be reached wherever it lives, even outside the project root — while the absolute blocks on system paths and secret files stay in force at every level, and the autonomous idle path is unchanged; trust here is the source of the request, not a permission level. On the same principle, the four built-in skills, which loaded and registered as tools but were dead-ended by the sandbox that blocked their child-process use, now run natively in process; a generated skill is never trusted and stays sandboxed.

### Multi-step work runs to completion

A single request that needs several steps no longer stalls or has to be nudged forward by hand. The chat tool-round budget rises from three to twelve so a build or an inspection finishes in one turn; a plan is carried out to completion rather than pausing after each step to ask whether to proceed; a false-stop recovery re-drives a model that narrates its next action without emitting the call, so it performs the step or delivers the result instead of ending the turn; and read-only shell commands the model writes in a code fence — `cat`, `find`, `ls` — are executed through the OS-adapting shell, translated to their Windows equivalents, so the model receives real output instead of concluding a file is missing when it exists. Anything that writes, deletes, installs, or executes is never auto-run and stays a shown block.

### Persisting a generated summary

Writing a generated summary to a file failed because the summary is a reference to prior output rather than literal text, and because there was no handler that writes into an existing file. The agent now remembers the last summary it produced for a short window, and a write command persists either that summary when it is referred to or any literal text the request supplies, into a named file or the last file touched, overwriting only on an explicit write. Whatever text the request gives is written; the remembered summary is one available source, not a prompt the agent volunteers.

### Smaller corrections

A shell step now checks whether its command is installed before it runs rather than only surfacing the gap after it fails; the run button reports a script's output, its error, or that it produced none instead of a raw result object; and a plan may hold as many steps as the loop can execute rather than being truncated to eight while the loop ran twenty.

## Older versions

- [CHANGELOG-v7.md](CHANGELOG-v7.md) — full v7.x history
- [docs/CHANGELOG-v6.md](docs/CHANGELOG-v6.md) — v6.x history
- [docs/CHANGELOG-v5.md](docs/CHANGELOG-v5.md) — v5.x history
- [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md) — v0.x–v4.x archive
