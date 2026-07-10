// Root entrypoint for the bridge worker.
// This wrapper keeps the top-level launch command simple while the actual worker
// implementation remains inside the events/ folder.

require('./events/bridgeworker');
