const fs = require('fs');
const path = require('path');

const siteId = process.argv[2];

if (!siteId) {
    console.error('❌ Error: Please provide a Site ID.');
    console.error('Usage: npm run set-site <YourSiteID>');
    process.exit(1);
}

const jobsFile = path.join(__dirname, '../metadata/site_template/jobs.xml');

try {
    let content = fs.readFileSync(jobsFile, 'utf8');

    // Replace any <context site-id="..."/> with the new site ID
    const updatedContent = content.replace(/<context site-id="[^"]+"\/>/g, `<context site-id="${siteId}"/>`);

    if (content !== updatedContent) {
        fs.writeFileSync(jobsFile, updatedContent, 'utf8');
        console.log(`✅ Successfully updated jobs.xml to use site-id: "${siteId}"`);
    } else {
        console.log(`ℹ️ No changes made. (Is the site ID already "${siteId}"?)`);
    }
} catch (error) {
    console.error(`❌ Failed to update jobs.xml: ${error.message}`);
    process.exit(1);
}
