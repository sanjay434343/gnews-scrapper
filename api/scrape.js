// api/scrape.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// URL validation function
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Extract clean text content
function extractCleanText($, selectors) {
  for (const selector of selectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      // Remove unwanted elements
      elements.find('script, style, nav, header, footer, .advertisement, .ads, .social-share').remove();
      
      let text = '';
      elements.each((i, el) => {
        text += $(el).text().trim() + ' ';
      });
      
      return text.trim().replace(/\s+/g, ' ');
    }
  }
  return '';
}

// Extract images
function extractImages($, baseUrl) {
  const images = [];
  const imgSelectors = [
    'img[src*="content"]',
    'img[src*="image"]',
    'img[src*="photo"]',
    '.article-image img',
    '.story-image img',
    '.content-image img',
    'img'
  ];

  imgSelectors.forEach(selector => {
    $(selector).each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('placeholder')) {
        try {
          const fullUrl = new URL(src, baseUrl).href;
          if (!images.includes(fullUrl)) {
            images.push(fullUrl);
          }
        } catch (e) {
          // Skip invalid URLs
        }
      }
    });
  });

  return images;
}

// Extract timestamp
function extractTimestamp($) {
  const timeSelectors = [
    'time[datetime]',
    '.timestamp',
    '.published-date',
    '.article-date',
    '.story-date',
    '.date-time',
    '[data-date]',
    '.byline time'
  ];

  for (const selector of timeSelectors) {
    const element = $(selector).first();
    if (element.length > 0) {
      const datetime = element.attr('datetime') || element.attr('data-date') || element.text().trim();
      if (datetime) {
        const date = new Date(datetime);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      }
    }
  }

  // Try to extract from URL or meta tags
  const metaDate = $('meta[property="article:published_time"]').attr('content') ||
                  $('meta[name="publishdate"]').attr('content') ||
                  $('meta[name="date"]').attr('content');
  
  if (metaDate) {
    const date = new Date(metaDate);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

// Extract location
function extractLocation($, content) {
  // Look for location in specific elements
  const locationSelectors = [
    '.dateline',
    '.location',
    '.article-location',
    '.story-location'
  ];

  for (const selector of locationSelectors) {
    const locationText = $(selector).first().text().trim();
    if (locationText) {
      return locationText;
    }
  }

  // Extract from content using common Indian cities/states
  const indianLocations = [
    'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad',
    'Jaipur', 'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Bhopal', 'Visakhapatnam', 'Patna',
    'Maharashtra', 'Karnataka', 'Andhra Pradesh', 'Tamil Nadu', 'Gujarat', 'Rajasthan',
    'West Bengal', 'Madhya Pradesh', 'Uttar Pradesh', 'Odisha', 'Kerala', 'Punjab', 'Haryana'
  ];

  for (const location of indianLocations) {
    if (content.toLowerCase().includes(location.toLowerCase())) {
      return location;
    }
  }

  return null;
}

// Extract category/topic
function extractCategory($, url) {
  // Try breadcrumbs first
  const breadcrumbs = $('.breadcrumb a, .breadcrumbs a, nav a').map((i, el) => $(el).text().trim()).get();
  if (breadcrumbs.length > 1) {
    return breadcrumbs[breadcrumbs.length - 2]; // Second to last breadcrumb is usually the category
  }

  // Try URL path
  try {
    const urlPath = new URL(url).pathname;
    const pathSegments = urlPath.split('/').filter(segment => segment.length > 0);
    const possibleCategories = ['sports', 'politics', 'business', 'technology', 'entertainment', 'health', 'education', 'world'];
    
    for (const segment of pathSegments) {
      if (possibleCategories.includes(segment.toLowerCase())) {
        return segment.charAt(0).toUpperCase() + segment.slice(1);
      }
    }
  } catch (e) {
    // Skip if URL parsing fails
  }

  // Try meta tags
  const metaCategory = $('meta[property="article:section"]').attr('content') ||
                      $('meta[name="section"]').attr('content') ||
                      $('meta[name="category"]').attr('content');
  
  if (metaCategory) {
    return metaCategory;
  }

  return null;
}

// Site-specific selectors for popular Indian news sites
const siteSelectors = {
  'ndtv.com': {
    title: 'h1.ins_story-headline, h1, .ins_storybody h1, .story-title',
    subtitle: '.intro, .story-intro, .summary, .ins_story-summary',
    content: '.ins_storybody, .story-content, .article-content, .ins_story-content',
  },
  'timesofindia.indiatimes.com': {
    title: 'h1, .headline, ._3YYSt, .HNMDR',
    subtitle: '.synopsis, .summary, ._1Y9nQ, .yJ3wK',
    content: '.Normal, ._3WlLe, .story-content, .ga-headlines',
  },
  'news18.com': {
    title: 'h1, .article-title, .story-kicker, .jsx-1159aa8b-ArticleSchema',
    subtitle: '.article-excerpt, .story-excerpt, .jsx-1159aa8b-ArticleSchema p',
    content: '.article-content, .story-content, .jsx-parser, .jsx-1159aa8b-ArticleSchema div',
  },
  'hindustantimes.com': {
    title: 'h1, .headline, .story-title, .hdg1',
    subtitle: '.stand-first, .story-summary, .detail-summary',
    content: '.story-details, .detail-body, .story-element-text',
  },
  'indianexpress.com': {
    title: 'h1, .native_story_title, .story-title, .heading1',
    subtitle: '.synopsis, .story-summary, .custom-caption',
    content: '.full-details, .story-element-text, .ie-contentbox',
  },
  'thehindu.com': {
    title: 'h1, .title, .article-title',
    subtitle: '.intro, .subhead, .article-intro',
    content: '.content, .paywall, .article-content p',
  },
  'indiatimes.com': {
    title: 'h1, .article_title, .story-title',
    subtitle: '.article_summary, .story-intro',
    content: '.article_content, .story-content',
  }
};

// User agent rotation
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// Get random user agent
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Enhanced request headers
function getRequestHeaders(url) {
  const hostname = new URL(url).hostname;
  
  return {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'Referer': `https://${hostname}/`,
    'Origin': `https://${hostname}`
  };
}

// Main scraping function with retry logic
async function scrapeArticle(url) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} for ${url}`);
      
      // Add delay between retries
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }

      // Fetch the webpage
      const response = await axios.get(url, {
        timeout: 15000,
        headers: getRequestHeaders(url),
        maxRedirects: 5,
        validateStatus: function (status) {
          return status >= 200 && status < 300;
        }
      });

      const $ = cheerio.load(response.data);
      const hostname = new URL(url).hostname;
      
      // Check if we got a valid HTML response
      if (!response.data || response.data.length < 100) {
        throw new Error('Received empty or invalid response');
      }

      // Check for common blocking patterns
      const bodyText = $('body').text().toLowerCase();
      if (bodyText.includes('access denied') || bodyText.includes('blocked') || bodyText.includes('captcha')) {
        throw new Error('Access blocked by website');
      }
      
      // Get site-specific selectors or use defaults
      const selectors = siteSelectors[hostname] || {};
      
      // Extract title
      const titleSelectors = selectors.title ? [selectors.title] : [
        'h1',
        '.article-title',
        '.story-title',
        '.headline',
        'title'
      ];
      const title = extractCleanText($, titleSelectors) || $('title').text().trim();

      // Extract subtitle
      const subtitleSelectors = selectors.subtitle ? [selectors.subtitle] : [
        '.subtitle',
        '.article-subtitle',
        '.story-summary',
        '.excerpt',
        '.intro',
        '.lead'
      ];
      const subtitle = extractCleanText($, subtitleSelectors);

      // Extract main content
      const contentSelectors = selectors.content ? [selectors.content] : [
        '.article-content',
        '.story-content',
        '.content',
        '.post-content',
        '.entry-content',
        '[data-module="ArticleBody"]',
        '.article-body',
        'main p'
      ];
      const content = extractCleanText($, contentSelectors);

      // Validate that we extracted meaningful content
      if (!title && !content) {
        throw new Error('No meaningful content found - possible blocking or invalid page');
      }

      // Extract other fields
      const images = extractImages($, url);
      const timestamp = extractTimestamp($);
      const location = extractLocation($, content);
      const category = extractCategory($, url);

      return {
        success: true,
        data: {
          url,
          title: title || null,
          subtitle: subtitle || null,
          content: content || null,
          images: images.length > 0 ? images : null,
          timestamp,
          location,
          category,
          scraped_at: new Date().toISOString()
        }
      };

    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt} failed:`, error.message);
      
      // Don't retry on certain errors
      if (error.response?.status === 404 || error.message.includes('Invalid URL')) {
        break;
      }
    }
  }

  throw new Error(`Scraping failed after ${maxRetries} attempts: ${lastError.message}`);
}

// Alternative scraping method using different approach
async function tryAlternativeScraping(url) {
  try {
    // Try with minimal headers first
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'curl/7.68.0'
      }
    });

    if (response.data && response.data.length > 100) {
      return response.data;
    }
  } catch (error) {
    console.log('Alternative method failed:', error.message);
  }
  
  return null;
}

// Main API route
app.get('/api/scrape', async (req, res) => {
  try {
    const { url } = req.query;

    // Validate URL parameter
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required'
      });
    }

    // Validate URL format
    if (!isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format'
      });
    }

    // Try to scrape the article
    let result;
    try {
      result = await scrapeArticle(url);
    } catch (primaryError) {
      console.log('Primary scraping failed, trying alternative method...');
      
      // Try alternative scraping method
      const alternativeData = await tryAlternativeScraping(url);
      if (alternativeData) {
        const $ = cheerio.load(alternativeData);
        const hostname = new URL(url).hostname;
        const selectors = siteSelectors[hostname] || {};
        
        const title = extractCleanText($, selectors.title ? [selectors.title] : ['h1', 'title']) || $('title').text().trim();
        const content = extractCleanText($, selectors.content ? [selectors.content] : ['.article-content', '.content', 'main p']);
        
        if (title || content) {
          result = {
            success: true,
            data: {
              url,
              title: title || null,
              subtitle: null,
              content: content || null,
              images: extractImages($, url),
              timestamp: extractTimestamp($),
              location: extractLocation($, content || ''),
              category: extractCategory($, url),
              scraped_at: new Date().toISOString(),
              method: 'alternative'
            }
          };
        } else {
          throw primaryError;
        }
      } else {
        throw primaryError;
      }
    }
    
    res.json(result);

  } catch (error) {
    console.error('Scraping error:', error);
    
    // Provide more specific error messages
    let errorMessage = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.response?.status === 403) {
      errorMessage = 'Access denied by website. The site may be blocking automated requests.';
      statusCode = 403;
    } else if (error.response?.status === 404) {
      errorMessage = 'Article not found. Please check the URL.';
      statusCode = 404;
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      errorMessage = 'Unable to connect to the website. Please check the URL.';
      statusCode = 400;
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Request timeout. The website took too long to respond.';
      statusCode = 408;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      url: req.query.url || null
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
