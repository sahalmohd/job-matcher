(() => {
  const SCAN_INTERVAL = 3000;
  const seenJobs = new Set();

  function extractJobCards() {
    const jobs = [];

    // Indeed job cards in search results
    const cards = document.querySelectorAll('.job_seen_beacon, .jobsearch-ResultsList .result, .tapItem');
    for (const card of cards) {
      const titleEl = card.querySelector('h2.jobTitle a, .jobTitle > a, a.jcs-JobTitle');
      const companyEl = card.querySelector('[data-testid="company-name"], .companyName, .company');
      const locationEl = card.querySelector('[data-testid="text-location"], .companyLocation, .location');
      const snippetEl = card.querySelector('.job-snippet, .underShelfFooter, .heading6');

      const title = titleEl?.textContent?.trim();
      const rawHref = titleEl?.href || titleEl?.closest('a')?.href;
      const url = rawHref ? new URL(rawHref, window.location.origin).href : null;
      const company = companyEl?.textContent?.trim();
      const location = locationEl?.textContent?.trim();
      const snippet = snippetEl?.textContent?.trim() || '';

      if (title && url && !seenJobs.has(url)) {
        seenJobs.add(url);
        jobs.push({
          title,
          company,
          location,
          description: snippet,
          url,
          platform: 'indeed',
        });
      }
    }

    return jobs;
  }

  function extractJobDetail() {
    // Full job description on the detail page or side panel
    const descEl = document.querySelector(
      '#jobDescriptionText, .jobsearch-jobDescriptionText, .jobsearch-JobComponent-description'
    );
    const titleEl = document.querySelector(
      '.jobsearch-JobInfoHeader-title, h1[data-testid="jobsearch-JobInfoHeader-title"]'
    );
    const companyEl = document.querySelector(
      '[data-testid="inlineHeader-companyName"], .jobsearch-InlineCompanyRating-companyHeader'
    );
    const locationEl = document.querySelector(
      '[data-testid="inlineHeader-companyLocation"], .jobsearch-JobInfoHeader-subtitle > div:nth-child(2)'
    );

    if (!descEl) return null;

    return {
      title: titleEl?.textContent?.trim() || '',
      company: companyEl?.textContent?.trim() || '',
      location: locationEl?.textContent?.trim() || '',
      description: descEl?.textContent?.trim() || '',
      url: window.location.href,
      platform: 'indeed',
    };
  }

  function scan() {
    const cards = extractJobCards();
    const detail = extractJobDetail();

    const payload = { type: 'JOBS_FOUND', source: 'indeed', jobs: [] };

    if (detail && detail.description) {
      const key = detail.url || detail.title;
      if (!seenJobs.has('detail:' + key)) {
        seenJobs.add('detail:' + key);
        payload.jobs.push(detail);
      }
    }

    for (const card of cards) {
      payload.jobs.push(card);
    }

    if (payload.jobs.length > 0) {
      chrome.runtime.sendMessage(payload);
    }
  }

  const observer = new MutationObserver(() => {
    const detail = extractJobDetail();
    if (detail && detail.description && !seenJobs.has('enriched:' + detail.url)) {
      seenJobs.add('enriched:' + detail.url);
      chrome.runtime.sendMessage({
        type: 'JOBS_FOUND',
        source: 'indeed',
        jobs: [detail],
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  setInterval(scan, SCAN_INTERVAL);
  scan();
})();
