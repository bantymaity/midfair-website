module.exports = function(eleventyConfig) {
  // মূল স্ট্যাটিক ফাইল ও api ফোল্ডার আউটপুটে কপি করবে
  eleventyConfig.addPassthroughCopy("index.html");
  eleventyConfig.addPassthroughCopy("about.html");
  eleventyConfig.addPassthroughCopy("contact.html");
  eleventyConfig.addPassthroughCopy("privacy.html");
  eleventyConfig.addPassthroughCopy("terms.html");
  eleventyConfig.addPassthroughCopy("recover-letter.html");
  eleventyConfig.addPassthroughCopy("api");
  eleventyConfig.addPassthroughCopy("assets");

  // তারিখ সুন্দর করে দেখানোর ফিল্টার (যেমন: November 25, 2026)
  eleventyConfig.addFilter("readableDate", (dateObj) => {
    const d = dateObj ? new Date(dateObj) : new Date();
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC"
    });
  });

  // Google Schema ও Sitemap-এর জন্য ISO তারিখ ফিল্টার (YYYY-MM-DD)
  eleventyConfig.addFilter("isoDate", (dateObj) => {
    const d = dateObj ? new Date(dateObj) : new Date();
    return d.toISOString().split("T")[0];
  });

  // পোস্ট পড়ার সময় (Read Time) হিসাব করার ফিল্টার
  eleventyConfig.addFilter("readingTime", (content) => {
    const words = (content || "").replace(/<[^>]*>/g, "").split(/\s+/).length;
    const mins = Math.max(1, Math.ceil(words / 200));
    return `${mins} min read`;
  });

  // সব ব্লগ পোস্ট নতুন থেকে পুরনো ক্রমে সাজানো
  eleventyConfig.addCollection("posts", function(collectionApi) {
    return collectionApi.getFilteredByGlob("posts/*.md").reverse();
  });

  return {
    dir: {
      input: ".",
      includes: "_includes",
      output: "_site"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
};
