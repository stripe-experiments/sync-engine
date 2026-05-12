chrome.runtime
  .sendMessage({ kind: 'content:dashboard_ready' })
  .catch(() => {
    /* background SW may not be ready yet — Chrome will retry on next page load */
  })
