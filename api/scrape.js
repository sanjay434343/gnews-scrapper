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
    title: 'h1, .ins_storybody h1, .story-title',
    subtitle: '.intro, .story-intro, .summary',
    content: '.ins_storybody, .story-content, .article-content',
  },
  'timesofindia.indiatimes.com': {
    title: 'h1, .headline, ._3YYSt',
    subtitle: '.synopsis, .summary, ._1Y9nQ',
    content: '.Normal, ._3WlLe, .story-content',
  },
  'news18.com': {
    title: 'h1, .article-title, .story-kicker',
    subtitle: '.article-excerpt, .story-excerpt',
    content: '.article-content, .story-content, .jsx-parser',
  },
  'hindustantimes.com': {
    title: 'h1, .headline, .story-title',
    subtitle: '.stand-first, .story-summary',
    content: '.story-details, .detail-body',
  },
  'indianexpress.com': {
    title: 'h1, .native_story_title, .story-title',
    subtitle: '.synopsis, .story-summary',
    content: '.full-details, .story-element-text',
  }
};

// Main scraping function
async function scrapeArticle(url) {
  try {
    // Fetch the webpage
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const hostname = new URL(url).hostname;
    
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
    throw new Error(`Scraping failed: ${error.message}`);
  }
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

    // Scrape the article
    const result = await scrapeArticle(url);
    
    res.json(result);

  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
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
