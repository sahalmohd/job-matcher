(() => {
  const SCAN_INTERVAL = 2000;
  const seenJobs = new Set();
  let lastUrl = '';

  /**
   * Randomised delay around a base interval.
   *
   * Every wait in this script used to be a fixed constant, which makes the
   * traffic pattern trivially distinguishable from a person reading listings.
   */
  function jitter(baseMs, spread = 0.35) {
    return Math.round(baseMs * (1 + (Math.random() * 2 - 1) * spread));
  }

  function cleanJobUrl(raw) {
    if (!raw) return raw;
    try {
      const u = new URL(raw);
      return u.origin + u.pathname.replace(/\/$/, '');
    } catch {
      return raw.split('?')[0].replace(/\/$/, '');
    }
  }

  function extractJobCards() {
    const jobs = [];

    const cards = document.querySelectorAll(
      [
        '.job-card-container',
        '.jobs-search-results__list-item',
        '.scaffold-layout__list-item',
        'li.jobs-search-results__list-item',
        'li[data-occludable-job-id]',
        '.job-card-list',
        'div.job-card-container--clickable',
        '[data-job-id]',
        '.jobs-search-results-list li',
      ].join(',')
    );

    for (const card of cards) {
      const titleEl =
        card.querySelector('a[href*="/jobs/view/"]') ||
        card.querySelector('.job-card-list__title') ||
        card.querySelector('.job-card-container__link') ||
        card.querySelector('a.job-card-list__title--link') ||
        card.querySelector('strong');

      const companyEl =
        card.querySelector('.job-card-container__primary-description') ||
        card.querySelector('.artdeco-entity-lockup__subtitle') ||
        card.querySelector('.job-card-container__company-name') ||
        card.querySelector('span.job-card-container__primary-description') ||
        card.querySelector('[class*="company"]') ||
        card.querySelector('[class*="subtitle"]');

      const locationEl =
        card.querySelector('.job-card-container__metadata-item') ||
        card.querySelector('.artdeco-entity-lockup__caption') ||
        card.querySelector('.job-card-container__metadata-wrapper li') ||
        card.querySelector('[class*="location"]') ||
        card.querySelector('[class*="caption"]');

      let snippet = '';
      if (isScheduledScan) {
        const snippetEl =
          card.querySelector('.job-card-list__insight') ||
          card.querySelector('.job-card-container__footer-wrapper') ||
          card.querySelector('[class*="insight"]');
        snippet = snippetEl?.textContent?.trim() || '';
      }

      const title = titleEl?.textContent?.trim();
      const rawUrl = titleEl?.href || titleEl?.closest('a')?.href || card.querySelector('a')?.href;
      const url = cleanJobUrl(rawUrl);
      const company = companyEl?.textContent?.trim();
      const location = locationEl?.textContent?.trim();

      if (title && url && !seenJobs.has(url)) {
        seenJobs.add(url);
        jobs.push({
          title,
          company,
          location,
          description: snippet,
          url,
          platform: 'linkedin',
        });
      }
    }

    // Fallback: if no cards found via structured selectors, find all job links
    if (jobs.length === 0) {
      const allLinks = document.querySelectorAll('a[href*="/jobs/view/"]');
      for (const link of allLinks) {
        const url = cleanJobUrl(link.href);
        if (!url || seenJobs.has(url)) continue;
        const title = link.textContent?.trim();
        if (!title || title.length < 3) continue;
        seenJobs.add(url);

        let company = '';
        let location = '';
        const parent = link.closest('li') || link.closest('[class*="card"]') || link.parentElement;
        if (parent) {
          const subtitleEl = parent.querySelector('[class*="subtitle"]') ||
            parent.querySelector('[class*="company"]') ||
            parent.querySelector('[class*="primary-description"]');
          company = subtitleEl?.textContent?.trim() || '';

          const locEl = parent.querySelector('[class*="location"]') ||
            parent.querySelector('[class*="caption"]') ||
            parent.querySelector('[class*="metadata"]');
          location = locEl?.textContent?.trim() || '';
        }

        jobs.push({
          title,
          company,
          location,
          description: '',
          url,
          platform: 'linkedin',
        });
      }
    }

    return jobs;
  }

  function extractJobDetail() {
    const descEl =
      document.querySelector('.jobs-description__content') ||
      document.querySelector('.jobs-description-content__text') ||
      document.querySelector('.jobs-box__html-content') ||
      document.querySelector('#job-details') ||
      document.querySelector('[class*="jobs-description"]') ||
      document.querySelector('.jobs-unified-description__content') ||
      document.querySelector('article[class*="jobs"]') ||
      document.querySelector('[class*="description__text"]') ||
      document.querySelector('.jobs-details__main-content [class*="description"]');

    const titleEl =
      document.querySelector('.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('.jobs-unified-top-card__job-title') ||
      document.querySelector('h1[class*="job-title"]') ||
      document.querySelector('.t-24.job-details-jobs-unified-top-card__job-title') ||
      document.querySelector('h1 a[href*="/jobs/view/"]') ||
      document.querySelector('h2[class*="job-title"]') ||
      document.querySelector('h1') ||
      document.querySelector('[class*="top-card"] [class*="title"]');

    const companyEl =
      document.querySelector('.job-details-jobs-unified-top-card__company-name') ||
      document.querySelector('.jobs-unified-top-card__company-name') ||
      document.querySelector('span[class*="company-name"]') ||
      document.querySelector('a[href*="/company/"]') ||
      document.querySelector('[class*="top-card"] [class*="company"]');

    const locationEl =
      document.querySelector('.job-details-jobs-unified-top-card__bullet') ||
      document.querySelector('.jobs-unified-top-card__bullet') ||
      document.querySelector('span[class*="workplace-type"]') ||
      document.querySelector('.job-details-jobs-unified-top-card__primary-description-container span') ||
      document.querySelector('[class*="top-card"] [class*="location"]') ||
      document.querySelector('[class*="top-card"] [class*="bullet"]');

    if (!descEl) return null;

    const description = descEl.textContent?.trim() || '';
    if (description.length < 10) return null;

    let jobUrl = window.location.href;
    const canonLink = document.querySelector('link[rel="canonical"]');
    if (canonLink?.href) jobUrl = canonLink.href;
    jobUrl = cleanJobUrl(jobUrl);

    return {
      title: titleEl?.textContent?.trim() || '',
      company: companyEl?.textContent?.trim() || '',
      location: locationEl?.textContent?.trim() || '',
      description,
      url: jobUrl,
      platform: 'linkedin',
    };
  }

  function sendJobs(jobs) {
    if (jobs.length === 0) return;
    try {
      chrome.runtime.sendMessage({
        type: 'JOBS_FOUND',
        source: 'linkedin',
        jobs,
      }, (response) => {
        if (chrome.runtime.lastError) {
          // Service worker may have been inactive; retry once after a short delay
          setTimeout(() => {
            try {
              chrome.runtime.sendMessage({
                type: 'JOBS_FOUND',
                source: 'linkedin',
                jobs,
              });
            } catch {}
          }, 1000);
        }
      });
    } catch {
      // Extension context invalidated
    }
  }

  function scan() {
    const cards = extractJobCards();
    const detail = extractJobDetail();
    const jobs = [];

    if (detail && detail.description) {
      const key = detail.url || detail.title;
      if (!seenJobs.has('detail:' + key)) {
        seenJobs.add('detail:' + key);
        jobs.push(detail);
      }
    }

    for (const card of cards) {
      jobs.push(card);
    }

    sendJobs(jobs);
  }

  // ---- Enrichment mode: extract detail from a single job page ----
  function runEnrichMode() {
    let attempts = 0;
    const maxAttempts = 10;
    const retryInterval = 800;

    function tryExtract() {
      attempts++;
      const detail = extractJobDetail();
      if (detail && detail.description) {
        console.log(`[JM Enrich] Extracted detail on attempt ${attempts}: ${detail.title} (${detail.description.length} chars)`);
        try {
          chrome.runtime.sendMessage({
            type: 'SCAN_JOB_DETAIL',
            job: detail,
          });
        } catch {}
        return;
      }
      console.log(`[JM Enrich] Attempt ${attempts}/${maxAttempts}: no detail found yet`);
      if (attempts < maxAttempts) {
        setTimeout(tryExtract, jitter(retryInterval));
      } else {
        console.log('[JM Enrich] All attempts exhausted, sending null');
        try {
          chrome.runtime.sendMessage({
            type: 'SCAN_JOB_DETAIL',
            job: null,
          });
        } catch {}
      }
    }

    setTimeout(tryExtract, jitter(1500));
  }

  // ---- Scheduled scan mode: aggressive multi-pass extraction ----
  function runScheduledScanMode() {
    let passes = 0;
    const maxPasses = 5;
    const passInterval = 2500;
    const allJobs = [];

    function reportProgress(step, detail) {
      try {
        chrome.runtime.sendMessage({
          type: 'SCAN_PROGRESS',
          step,
          detail,
          pass: passes,
          maxPasses,
          jobsSoFar: allJobs.length,
        });
      } catch {}
    }

    function scheduledPass() {
      passes++;
      reportProgress('extracting', `Pass ${passes}/${maxPasses} — scanning page`);

      const cards = extractJobCards();
      const detail = extractJobDetail();

      if (detail && detail.description) {
        const key = detail.url || detail.title;
        if (!seenJobs.has('detail:' + key)) {
          seenJobs.add('detail:' + key);
          allJobs.push(detail);
        }
      }

      for (const card of cards) {
        allJobs.push(card);
      }

      reportProgress('scrolling', `Pass ${passes}/${maxPasses} — ${allJobs.length} jobs found, loading more`);

      const listEl =
        document.querySelector('.jobs-search-results-list') ||
        document.querySelector('.scaffold-layout__list') ||
        document.querySelector('[class*="jobs-search-results"]');
      if (listEl) {
        listEl.scrollTop = listEl.scrollHeight;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }

      if (passes < maxPasses) {
        setTimeout(scheduledPass, jitter(passInterval));
      } else {
        reportProgress('done', `Complete — ${allJobs.length} jobs extracted`);
        try {
          chrome.runtime.sendMessage({
            type: 'SCAN_JOBS_LIST',
            source: 'linkedin',
            jobs: allJobs,
          });
        } catch {}
      }
    }

    reportProgress('loading', 'Waiting for LinkedIn to load');
    setTimeout(scheduledPass, jitter(3000));
  }

  // ---- Normal interactive mode ----

  function watchDetailPanel() {
    const observer = new MutationObserver(() => {
      clearTimeout(watchDetailPanel._timer);
      watchDetailPanel._timer = setTimeout(() => {
        const detail = extractJobDetail();
        if (detail && detail.description) {
          const key = detail.url || detail.title;
          if (!seenJobs.has('enriched:' + key)) {
            seenJobs.add('enriched:' + key);
            sendJobs([detail]);
          }
        }
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function watchNavigation() {
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(scan, 1000);
      }
    }, 1000);
  }

  function runInteractiveMode() {
    watchDetailPanel();
    watchNavigation();
    setInterval(scan, SCAN_INTERVAL);
    setTimeout(scan, 1500);
  }

  /**
   * Ask the background worker what this tab is for.
   *
   * The mode used to be read from `_jm_scan=1` / `_jm_enrich=1` query params
   * appended to the LinkedIn URL — a marker visible in the address bar, in
   * history, and in LinkedIn's own request logs, identifying every automated
   * page load. The background now records the mode against the tab id in
   * session storage instead, so the URLs we visit are ordinary ones.
   */
  chrome.runtime.sendMessage({ type: 'GET_TAB_MODE' }, (response) => {
    // A missing response means the worker is asleep or the context is gone;
    // interactive is the safe default.
    const mode = (!chrome.runtime.lastError && response && response.mode) || 'interactive';

    if (mode === 'enrich') return runEnrichMode();
    if (mode === 'scan') return runScheduledScanMode();
    runInteractiveMode();
  });
})();
