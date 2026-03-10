(() => {
  const SCAN_INTERVAL = 3000;
  const seenJobs = new Set();

  function extractJobCards() {
    const jobs = [];

    // Glassdoor job listing cards
    const cards = document.querySelectorAll(
      '.react-job-listing, [data-test="jobListing"], .JobsList_jobListItem__wjTHv, li[data-jobid]'
    );
    for (const card of cards) {
      const titleEl = card.querySelector(
        '.job-title, [data-test="job-title"], a.JobCard_jobTitle__GLyJ1'
      );
      const companyEl = card.querySelector(
        '.job-search-key-l2wjgv, [data-test="emp-name"], .EmployerProfile_employerName__PhWJI'
      );
      const locationEl = card.querySelector(
        '.job-search-key-1rdszc, [data-test="emp-location"], .JobCard_location__N_iYE'
      );

      const title = titleEl?.textContent?.trim();
      const rawHref = titleEl?.href || titleEl?.closest('a')?.href;
      const url = rawHref ? new URL(rawHref, window.location.origin).href : null;
      const company = companyEl?.textContent?.trim();
      const location = locationEl?.textContent?.trim();

      if (title && url && !seenJobs.has(url)) {
        seenJobs.add(url);
        jobs.push({
          title,
          company,
          location,
          url,
          platform: 'glassdoor',
        });
      }
    }

    return jobs;
  }

  function extractJobDetail() {
    const descEl = document.querySelector(
      '.jobDescriptionContent, [data-test="jobDescriptionContent"], .JobDetails_jobDescription__uW_fK'
    );
    const titleEl = document.querySelector(
      '[data-test="job-title"], .JobDetails_jobTitle__t4VJM, h1.heading_Heading__BqX5J'
    );
    const companyEl = document.querySelector(
      '[data-test="employerName"], .JobDetails_companyName__mSHBY, .EmployerProfile_employerName__PhWJI'
    );
    const locationEl = document.querySelector(
      '[data-test="location"], .JobDetails_location__MbnkO'
    );

    if (!descEl) return null;

    return {
      title: titleEl?.textContent?.trim() || '',
      company: companyEl?.textContent?.trim() || '',
      location: locationEl?.textContent?.trim() || '',
      description: descEl?.textContent?.trim() || '',
      url: window.location.href,
      platform: 'glassdoor',
    };
  }

  function scan() {
    const cards = extractJobCards();
    const detail = extractJobDetail();

    const payload = { type: 'JOBS_FOUND', source: 'glassdoor', jobs: [] };

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
        source: 'glassdoor',
        jobs: [detail],
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  setInterval(scan, SCAN_INTERVAL);
  scan();
})();
