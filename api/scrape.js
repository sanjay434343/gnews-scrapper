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

// Google News specific user agents that work better
const googleNewsUserAgents = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z‡ Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUserAgent() {
  return googleNewsUserAgents[Math.floor(Math.random() * googleNewsUserAgents.length)];
}

// Check if URL is Google News
function isGoogleNewsUrl(url) {
  return url.includes('news.google.com') || url.includes('google.com/url?');
}

// Extract actual article URL from Google News redirect
function extractActualUrl(googleUrl) {
  try {
    const urlObj = new URL(googleUrl);
    
    // For Google News article URLs like: https://news.google.com/articles/...
    if (urlObj.pathname.includes('/articles/')) {
      return googleUrl; // Keep as is, will be handled specially
    }
    
    // For Google redirect URLs like: https://www.google.com/url?url=...
    const actualUrl = urlObj.searchParams.get('url') || urlObj.searchParams.get('q');
    if (actualUrl) {
      return decodeURIComponent(actualUrl);
    }
    
    return googleUrl;
  } catch (error) {
    return googleUrl;
  }
}

// Decode Google News URL to get actual article URL
function decodeGoogleNewsUrl(encodedUrl) {
  try {
    // Google News RSS URLs are base64 encoded in a specific format
    if (encodedUrl.includes('news.google.com/rss/articles/')) {
      // Extract the encoded part after articles/
      const urlParts = encodedUrl.split('/articles/')[1];
      if (urlParts) {
        const encodedPart = urlParts.split('?')[0];
        
        // Try to decode the Google News encoded URL
        try {
          // Google News uses a custom encoding, try to extract patterns
          const decoded = decodeURIComponent(encodedPart);
          
          // Look for URL patterns in the decoded string
          const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
          const matches = decoded.match(urlRegex);
          
          if (matches && matches.length > 0) {
            // Return the first valid looking URL
            return matches[0];
          }
        } catch (e) {
          console.log('Decode attempt failed, trying alternative method');
        }
      }
    }
    
    return encodedUrl;
  } catch (error) {
    console.log('URL decode error:', error.message);
    return encodedUrl;
  }
}

// Fetch Google News article and extract redirect URL
async function resolveGoogleNewsUrl(googleUrl) {
  try {
    // First try to decode the URL
    const decodedUrl = decodeGoogleNewsUrl(googleUrl);
    if (decodedUrl !== googleUrl && !decodedUrl.includes('news.google.com')) {
      return decodedUrl;
    }
    
    // If decoding didn't work, try to fetch and follow redirects
    const response = await axios.get(googleUrl, {
      timeout: 10000,
      maxRedirects: 0, // Don't follow redirects automatically
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    // Check for redirect in response headers
    const location = response.headers.location;
    if (location && !location.includes('news.google.com')) {
      return location;
    }
    
    // If response is HTML, try to find the actual URL in meta tags or JavaScript
    if (response.data && typeof response.data === 'string') {
      const $ = cheerio.load(response.data);
      
      // Look for meta refresh
      const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
      if (metaRefresh) {
        const urlMatch = metaRefresh.match(/url=(.+)/i);
        if (urlMatch && urlMatch[1] && !urlMatch[1].includes('news.google.com')) {
          return urlMatch[1];
        }
      }
      
      // Look for canonical URL
      const canonical = $('link[rel="canonical"]').attr('href');
      if (canonical && !canonical.includes('news.google.com')) {
        return canonical;
      }
      
      // Look for URLs in JavaScript
      const scriptTags = $('script').text();
      const urlMatches = scriptTags.match(/https?:\/\/[^"'\s]+/g);
      if (urlMatches) {
        for (const url of urlMatches) {
          if (!url.includes('google.com') && !url.includes('gstatic.com') && 
              (url.includes('news') || url.includes('article') || url.includes('.com'))) {
            return url;
          }
        }
      }
    }
    
    return googleUrl;
  } catch (error) {
    if (error.response && error.response.headers.location) {
      const location = error.response.headers.location;
      if (!location.includes('news.google.com')) {
        return location;
      }
    }
    
    console.log('Failed to resolve Google News URL:', error.message);
    return googleUrl;
  }
}

// Alternative method to get actual article URLs from Google News search
async function getActualArticleUrls(query, limit = 5) {
  try {
    // Use Google News search page instead of RSS
    const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;
    
    const response = await axios.get(searchUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    const articles = [];
    
    // Extract article information from Google News page
    $('article').each((i, article) => {
      if (articles.length >= limit) return false;
      
      const $article = $(article);
      const titleElement = $article.find('h3, h4, [role="heading"]').first();
      const title = titleElement.text().trim();
      
      const linkElement = $article.find('a[href*="/articles/"]').first();
      const relativeLink = linkElement.attr('href');
      
      if (title && relativeLink) {
        const fullGoogleUrl = `https://news.google.com${relativeLink}`;
        articles.push({
          title,
          googleUrl: fullGoogleUrl,
          source: $article.find('[data-n-tid]').text().trim() || 'Unknown'
        });
      }
    });
    
    return articles;
  } catch (error) {
    console.log('Failed to get article URLs from Google News search:', error.message);
    return [];
  }
}

// Get Google News RSS feed with full content
async function getGoogleNewsRSS(query = 'india', lang = 'en', country = 'IN', includeContent = true) {
  try {
    // First, try to get articles using alternative method
    if (includeContent) {
      console.log('Attempting to get articles with resolved URLs...');
      const alternativeArticles = await getActualArticleUrls(query, 5);
      
      if (alternativeArticles.length > 0) {
        const articles = [];
        
        for (let i = 0; i < Math.min(alternativeArticles.length, 5); i++) {
          const article = alternativeArticles[i];
          console.log(`Processing article ${i + 1}: ${article.title.substring(0, 50)}...`);
          
          try {
            // Try to resolve the Google News URL
            const resolvedUrl = await resolveGoogleNewsUrl(article.googleUrl);
            console.log(`Resolved URL: ${resolvedUrl}`);
            
            if (resolvedUrl && !resolvedUrl.includes('news.google.com')) {
              // Fetch the actual article content
              const contentData = await scrapeOriginalArticle(resolvedUrl);
              
              articles.push({
                title: article.title,
                original_link: article.googleUrl,
                resolved_url: resolvedUrl,
                source: article.source,
                ...contentData,
                published: new Date().toISOString() // Approximate since we don't have exact time
              });
            } else {
              // If we can't resolve, still add the article info
              articles.push({
                title: article.title,
                original_link: article.googleUrl,
                resolved_url: null,
                source: article.source,
                content: null,
                images: null,
                timestamp: null,
                error: 'Could not resolve to original article URL'
              });
            }
            
            // Add delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (error) {
            console.log(`Failed to process article: ${error.message}`);
            articles.push({
              title: article.title,
              original_link: article.googleUrl,
              resolved_url: null,
              source: article.source,
              content: null,
              images: null,
              timestamp: null,
              error: `Processing failed: ${error.message}`
            });
          }
        }
        
        if (articles.length > 0) {
          return articles;
        }
      }
    }
    
    // Fallback to RSS method
    console.log('Falling back to RSS method...');
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
    
    const response = await axios.get(rssUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/rss+xml, application/xml, text/xml'
      }
    });

    const $ = cheerio.load(response.data, { xmlMode: true });
    const articles = [];

    // Process each RSS item
    const items = $('item').slice(0, 5); // Limit to 5 articles
    
    for (let i = 0; i < items.length; i++) {
      const item = items.eq(i);
      const title = item.find('title').text().trim();
      const link = item.find('link').text().trim();
      const description = item.find('description').text().trim();
      const pubDate = item.find('pubDate').text().trim();
      const source = item.find('source').text().trim();

      if (title && link) {
        let articleData = {
          title,
          original_link: link,
          description: description ? description.replace(/<[^>]*>/g, '').trim() : null,
          published: pubDate || null,
          source: source || null,
          content: null,
          images: null,
          resolved_url: null
        };

        // If includeContent is true, try to fetch the full article content
        if (includeContent) {
          try {
            console.log(`Attempting to resolve RSS article ${i + 1}: ${title.substring(0, 50)}...`);
            
            // Try to resolve the Google News URL
            const actualUrl = await resolveGoogleNewsUrl(link);
            console.log(`RSS resolved URL: ${actualUrl}`);
            
            if (actualUrl && actualUrl !== link && !actualUrl.includes('news.google.com')) {
              articleData.resolved_url = actualUrl;
              
              // Fetch the actual article content
              const contentData = await scrapeOriginalArticle(actualUrl);
              articleData.content = contentData.content;
              articleData.images = contentData.images;
              articleData.timestamp = contentData.timestamp;
              articleData.word_count = contentData.word_count;
            } else {
              articleData.error = 'Could not resolve Google News URL to original source';
            }
            
            // Add delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            console.log(`Failed to fetch content for RSS article: ${error.message}`);
            articleData.error = `Content fetch failed: ${error.message}`;
          }
        }

        articles.push(articleData);
      }
    }

    return articles;
  } catch (error) {
    throw new Error(`Failed to fetch Google News: ${error.message}`);
  }
}

// Enhanced article scraping with better selectors
async function scrapeOriginalArticle(url) {
  const maxRetries = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        maxRedirects: 5
      });

      const $ = cheerio.load(response.data);
      const hostname = new URL(url).hostname;
      
      // Remove unwanted elements
      $('script, style, nav, header, footer, .advertisement, .ads, .social-share, .related-articles, .comments, iframe, .video-player').remove();

      // Extract title with priority order
      let title = '';
      const titleSelectors = [
        'h1[class*="headline"]',
        'h1[class*="title"]',
        'h1[class*="story"]',
        '[property="og:title"]',
        'h1',
        'title'
      ];

      for (const selector of titleSelectors) {
        if (selector === '[property="og:title"]') {
          title = $(selector).attr('content');
        } else if (selector === 'title') {
          title = $(selector).text().replace(/\s*\|\s*.*$/, '').trim();
        } else {
          title = $(selector).first().text().trim();
        }
        if (title && title.length > 10) break;
      }

      // Extract content with comprehensive selectors
      const contentSelectors = [
        '[data-module="ArticleBody"]',
        '.article-content',
        '.story-content',
        '.content',
        '.post-content',
        '.entry-content',
        '.article-body',
        '.story-body',
        'main article',
        'article',
        '.news-content',
        '.article-text',
        '.story-text'
      ];

      let content = '';
      let foundContent = false;

      for (const selector of contentSelectors) {
        const contentDiv = $(selector).first();
        if (contentDiv.length > 0) {
          // Find all paragraph tags within this content area
          const paragraphs = contentDiv.find('p, div.paragraph, .story-element-text');
          
          if (paragraphs.length > 0) {
            paragraphs.each((i, p) => {
              const text = $(p).text().trim();
              if (text.length > 30 && !text.toLowerCase().includes('advertisement')) {
                content += text + '\n\n';
              }
            });
            
            if (content.length > 200) {
              foundContent = true;
              break;
            }
          }
        }
      }

      // Fallback: try to get any substantial paragraphs
      if (!foundContent) {
        $('p').each((i, p) => {
          const text = $(p).text().trim();
          if (text.length > 50 && !text.toLowerCase().includes('advertisement') && !text.toLowerCase().includes('subscribe')) {
            content += text + '\n\n';
          }
        });
      }

      // Extract images with better filtering
      const images = [];
      const imgSelectors = [
        'img[class*="article"]',
        'img[class*="story"]',
        'img[class*="content"]',
        'img[class*="featured"]',
        'figure img',
        '.image-container img',
        'img'
      ];

      imgSelectors.forEach(selector => {
        $(selector).each((i, img) => {
          const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
          const alt = $(img).attr('alt') || '';
          
          if (src && 
              !src.includes('logo') && 
              !src.includes('icon') && 
              !src.includes('avatar') &&
              !src.includes('placeholder') &&
              !alt.toLowerCase().includes('logo') &&
              src.length > 20) {
            try {
              const fullUrl = new URL(src, url).href;
              if (!images.includes(fullUrl) && images.length < 10) {
                images.push(fullUrl);
              }
            } catch (e) {
              // Skip invalid URLs
            }
          }
        });
      });

      // Extract timestamp with multiple methods
      let timestamp = null;
      const timeSelectors = [
        'time[datetime]',
        '[property="article:published_time"]',
        '[name="publishdate"]',
        '[name="date"]',
        '.published-date',
        '.article-date',
        '.story-date',
        '.timestamp'
      ];

      for (const selector of timeSelectors) {
        const element = $(selector).first();
        if (element.length) {
          let dateStr = '';
          if (selector.startsWith('[')) {
            dateStr = element.attr('content') || element.attr('datetime');
          } else {
            dateStr = element.attr('datetime') || element.text().trim();
          }
          
          if (dateStr) {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
              timestamp = date.toISOString();
              break;
            }
          }
        }
      }

      // Validate that we got meaningful content
      if (!title && content.length < 100) {
        throw new Error('Insufficient content extracted - possible blocking or paywall');
      }

      return {
        title: title || null,
        content: content.trim() || null,
        images: images.length > 0 ? images : null,
        timestamp,
        source_url: url,
        word_count: content.split(' ').length
      };

    } catch (error) {
      lastError = error;
      console.log(`Article scraping attempt ${attempt} failed for ${url}: ${error.message}`);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  throw lastError;
}

// Main scraping function for Google News
async function scrapeGoogleNews(url, options = {}) {
  try {
    // If it's a Google News RSS request
    if (url === 'rss' || url.includes('rss')) {
      const includeContent = options.includeContent !== false; // Default to true
      const articles = await getGoogleNewsRSS(options.query, options.lang, options.country, includeContent);
      return {
        success: true,
        data: {
          type: 'rss_feed_with_content',
          query: options.query || 'india',
          articles: articles,
          total: articles.length,
          scraped_at: new Date().toISOString()
        }
      };
    }

    // Extract actual article URL if it's a Google News link
    const actualUrl = extractRealArticleUrl(url);
    
    // If it's still a Google News article URL, try to resolve it
    if (actualUrl.includes('news.google.com/articles/')) {
      const resolvedUrl = await resolveGoogleNewsUrl(actualUrl);
      if (resolvedUrl !== actualUrl) {
        const articleData = await scrapeOriginalArticle(resolvedUrl);
        return {
          success: true,
          data: {
            type: 'article',
            url: resolvedUrl,
            original_google_url: url,
            ...articleData,
            scraped_at: new Date().toISOString()
          }
        };
      } else {
        return {
          success: false,
          error: 'Unable to resolve Google News URL to original article source'
        };
      }
    }

    // Scrape the actual article
    const articleData = await scrapeOriginalArticle(actualUrl);
    
    return {
      success: true,
      data: {
        type: 'article',
        url: actualUrl,
        original_google_url: url !== actualUrl ? url : null,
        ...articleData,
        scraped_at: new Date().toISOString()
      }
    };

  } catch (error) {
    throw new Error(`Google News scraping failed: ${error.message}`);
  }
}

// Fallback: Get articles directly from news sites
async function getDirectNewsArticles(query, limit = 5) {
  const newsSites = [
    {
      name: 'BBC News',
      searchUrl: `https://www.bbc.com/search?q=${encodeURIComponent(query)}`,
      selectors: {
        articles: '[data-testid="liverpool-card"]',
        title: 'h3',
        link: 'a'
      }
    },
    {
      name: 'Reuters',
      rssUrl: `https://feeds.reuters.com/reuters/topNews`,
      type: 'rss'
    }
  ];

  const articles = [];
  
  for (const site of newsSites) {
    if (articles.length >= limit) break;
    
    try {
      if (site.type === 'rss') {
        // Handle RSS feeds
        const response = await axios.get(site.rssUrl, {
          timeout: 10000,
          headers: { 'User-Agent': getRandomUserAgent() }
        });
        
        const $ = cheerio.load(response.data, { xmlMode: true });
        
        $('item').slice(0, limit - articles.length).each((i, item) => {
          const $item = $(item);
          const title = $item.find('title').text().trim();
          const link = $item.find('link').text().trim();
          const description = $item.find('description').text().trim();
          
          if (title && link && title.toLowerCase().includes(query.toLowerCase())) {
            articles.push({
              title,
              original_link: link,
              resolved_url: link,
              source: site.name,
              description: description || null,
              needsContentFetch: true
            });
          }
        });
      }
    } catch (error) {
      console.log(`Failed to get articles from ${site.name}: ${error.message}`);
    }
  }
  
  return articles;
}

// Main API route with enhanced error handling and fallbacks
app.get('/api/scrape', async (req, res) => {
  try {
    const { 
      url, 
      query = 'technology', 
      lang = 'en', 
      country = 'IN', 
      type = 'article',
      include_content = 'true',
      limit = '3',
      fallback = 'true'
    } = req.query;

    // Handle RSS feed requests with full content
    if (type === 'rss' || url === 'rss') {
      const includeContent = include_content.toLowerCase() !== 'false';
      const useFallback = fallback.toLowerCase() !== 'false';
      
      try {
        const result = await scrapeGoogleNews('rss', { 
          query, 
          lang, 
          country, 
          includeContent,
          limit: parseInt(limit) 
        });
        
        // If Google News didn't return good results and fallback is enabled, try direct sources
        if (useFallback && result.data.articles.length === 0) {
          console.log('Google News returned no results, trying direct sources...');
          const directArticles = await getDirectNewsArticles(query, parseInt(limit));
          
          // Fetch content for direct articles if needed
          for (const article of directArticles) {
            if (article.needsContentFetch && includeContent) {
              try {
                const contentData = await scrapeOriginalArticle(article.resolved_url);
                Object.assign(article, contentData);
                delete article.needsContentFetch;
              } catch (error) {
                article.error = `Content fetch failed: ${error.message}`;
              }
            }
          }
          
          result.data.articles = directArticles;
          result.data.source_method = 'direct_fallback';
        }
        
        return res.json(result);
      } catch (error) {
        // If everything fails, return a helpful error with examples
        return res.status(500).json({
          success: false,
          error: `Failed to fetch news: ${error.message}`,
          suggestions: {
            try_different_query: `/api/scrape?type=rss&query=sports&limit=3`,
            try_without_content: `/api/scrape?type=rss&query=${query}&include_content=false`,
            try_direct_url: `/api/scrape?url=https://www.bbc.com/news/technology-article`
          }
        });
      }
    }

    // Handle direct URL scraping
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL parameter is required for direct article scraping.',
        examples: {
          rss_with_content: `/api/scrape?type=rss&query=technology&include_content=true&limit=3`,
          rss_links_only: `/api/scrape?type=rss&query=sports&include_content=false`,
          single_article: `/api/scrape?url=https://www.example.com/news-article`
        }
      });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format. Please provide a valid HTTP/HTTPS URL.'
      });
    }

    // Scrape individual article
    const result = await scrapeGoogleNews(url);
    res.json(result);

  } catch (error) {
    console.error('Scraping error:', error);
    
    let errorMessage = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.response?.status === 403) {
      errorMessage = 'Access denied. The article source may be blocking requests.';
      statusCode = 403;
    } else if (error.response?.status === 404) {
      errorMessage = 'Article not found.';
      statusCode = 404;
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Unable to connect to the source website.';
      statusCode = 400;
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Request timeout. The operation took too long.';
      statusCode = 408;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      url: req.query.url || null,
      timestamp: new Date().toISOString()
    });
  }
});

// Google News RSS endpoint with enhanced content
app.get('/api/news', async (req, res) => {
  try {
    const { 
      query = 'india', 
      lang = 'en', 
      country = 'IN', 
      limit = '5',
      include_content = 'true'
    } = req.query;
    
    const includeContent = include_content.toLowerCase() !== 'false';
    const articles = await getGoogleNewsRSS(query, lang, country, includeContent);
    
    res.json({
      success: true,
      data: {
        query,
        include_content: includeContent,
        articles: articles.slice(0, parseInt(limit)),
        total_fetched: articles.length,
        scraped_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('RSS fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Google News Scraper',
    timestamp: new Date().toISOString() 
  });
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Google News Scraper running on port ${PORT}`);
  });
}

module.exports = app;
