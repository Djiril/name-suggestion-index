const colors = require('colors/safe');
const fs = require('fs');
const JSON5 = require('json5');
const shell = require('shelljs');
const stringify = require('@aitodotai/json-stringify-pretty-compact');

const fileTree = require('../lib/file_tree.js');
const idgen = require('../lib/idgen.js');
const matcher = require('../lib/matcher.js')();
const sort = require('../lib/sort.js');
const stemmer = require('../lib/stemmer.js');
const validate = require('../lib/validate.js');

// metadata about the trees
const trees = require('../config/trees.json').trees;

// We use LocationConflation for validating and processing the locationSets
const featureCollection = require('../dist/featureCollection.json');
const LocationConflation = require('@ideditor/location-conflation');
const loco = new LocationConflation(featureCollection);

console.log(colors.blue('-'.repeat(70)));
console.log(colors.blue('🗂   Build index'));
console.log(colors.blue('-'.repeat(70)));

let _config = {};
loadConfig();

let _collected = {};
loadCollected();

let _discard = {};
let _keep = {};
runFilters();

let _cache = {};
loadIndex();

checkItems('brands');
checkItems('flags');
checkItems('operators');
checkItems('transit');

mergeItems();

saveIndex();
console.log('');



//
// Load, validate, cleanup config files
//
function loadConfig() {
  ['trees', 'replacements', 'genericWords'].forEach(which => {
    const schema = require(`../schema/${which}.json`);
    const file = `config/${which}.json`;
    const contents = fs.readFileSync(file, 'utf8');
    let data;
    try {
      data = JSON5.parse(contents);
    } catch (jsonParseError) {
      console.error(colors.red(`Error - ${jsonParseError.message} reading:`));
      console.error('  ' + colors.yellow(file));
      process.exit(1);
    }

    // check JSON schema
    validate(file, data, schema);

    // Clean and sort the files for consistency, save them that way.
    if (which === 'trees') {
      Object.keys(data.trees).forEach(t => {
        let tree = data.trees[t];
        let cleaned = {
          emoji:      tree.emoji,
          mainTag:    tree.mainTag,
          nameTags: {
            primary:   tree.nameTags.primary,
            alternate: tree.nameTags.alternate,
          },
          keepKV:     tree.keepKV.map(s => s.toLowerCase()).sort(),
          discardKVN: tree.discardKVN.map(s => s.toLowerCase()).sort()
        };
        tree = cleaned;
      });

    } else if (which === 'replacements') {
      Object.keys(data.replacements).forEach(qid => {
        let replacement = data.replacements[qid];
        let cleaned = {
          note:      replacement.note,
          wikidata:  replacement.wikidata,
          wikipedia: replacement.wikipedia
        };
        replacement = cleaned;
      });

    } else if (which === 'genericWords') {
      data.genericWords = data.genericWords.map(s => s.toLowerCase()).sort();
    }

    // Lowercase and sort the files for consistency, save them that way.
    fs.writeFileSync(file, stringify(sort(data)) + '\n');

    _config[which] = data[which];
  });
}


//
// Load lists of tags collected from OSM from `dist/collected/*`
//
function loadCollected() {
  ['name', 'brand', 'operator', 'network'].forEach(tag => {
    const file = `dist/collected/${tag}s_all.json`;
    const contents = fs.readFileSync(file, 'utf8');
    let data;
    try {
      data = JSON5.parse(contents);
    } catch (jsonParseError) {
      console.error(colors.red(`Error - ${jsonParseError.message} reading:`));
      console.error('  ' + colors.yellow(file));
      process.exit(1);
    }

    _collected[tag] = data;
  });
}


//
// Filter the tags collected into _keep and _discard lists
//
function runFilters() {
  const START = '🏗   ' + colors.yellow(`Filtering values gathered from OSM...`);
  const END = '👍  ' + colors.green(`done filtering`);
  console.log('');
  console.log(START);
  console.time(END);

  // which trees use which tags?
  // note, 'flags' not seeded with collected data (yet?)
  const treeTags = {
    brands:     ['brand', 'name'],
    operators:  ['operator'],
    transit:    ['network']
  };

  Object.keys(treeTags).forEach(t => {
    const tree = _config.trees[t];
    let discard = _discard[t] = {};
    let keep = _keep[t] = {};

    // Start clean
    shell.rm('-f', [`dist/filtered/${t}_keep.json`, `dist/filtered/${t}_discard.json`]);

    // All the collected values start out in discard..
    treeTags[t].forEach(tag => {
      let collected = _collected[tag];
      for (const kvn in collected) {
        discard[kvn] = Math.max((discard[kvn] || 0), collected[kvn]);
      }
    });

    // Filter by keepKV (move from discard -> keep)
    tree.keepKV.forEach(s => {
      const re = new RegExp(s, 'i');
      for (const kvn in discard) {
        const kv = kvn.split('|', 2)[0];
        if (re.test(kv)) {
          keep[kvn] = discard[kvn];
          delete discard[kvn];
        }
      }
    });

    // Filter by discardKeys (move from keep -> discard)
    tree.discardKVN.forEach(s => {
      const re = new RegExp(s, 'i');
      for (const kvn in keep) {
        if (re.test(kvn)) {
          discard[kvn] = keep[kvn];
          delete keep[kvn];
        }
      }
    });

    // filter by discardNames (move from keep -> discard)
    _config.genericWords.forEach(s => {
      const re = new RegExp(s, 'i');
      for (let kvn in keep) {
        const name = kvn.split('|', 2)[1];
        if (re.test(name) || /;/.test(name)) {  // also discard values with semicolons
          discard[kvn] = keep[kvn];
          delete keep[kvn];
        }
      }
    });

    const discardCount = Object.keys(discard).length;
    const keepCount = Object.keys(keep).length;
    console.log(`${tree.emoji}  ${t}:\t${keepCount} keep, ${discardCount} discard`);

    fs.writeFileSync(`dist/filtered/${t}_discard.json`, stringify(sort(discard)) + '\n');
    fs.writeFileSync(`dist/filtered/${t}_keep.json`, stringify(sort(keep)) + '\n');

  });

  console.timeEnd(END);
}


//
// Load the index files under `data/*`
//
function loadIndex() {
  const START = '🏗   ' + colors.yellow(`Loading index files...`);
  const END = '👍  ' + colors.green(`done loading`);
  console.log('');
  console.log(START);
  console.time(END);

  fileTree.read(_cache, loco);
  console.timeEnd(END);

  const MATCH_INDEX_END = '👍  ' + colors.green(`built match index`);
  console.time(MATCH_INDEX_END);
  matcher.buildMatchIndex(_cache.path);
  console.timeEnd(MATCH_INDEX_END);

  // It takes a few seconds to resolve all of the locationSets into GeoJSON and insert into which-polygon
  // We don't need a location index for this script, but it's useful to know.
  const LOCATION_INDEX_END = '👍  ' + colors.green(`built location index`);
  console.time(LOCATION_INDEX_END);
  matcher.buildLocationIndex(_cache.path, loco);
  console.timeEnd(LOCATION_INDEX_END);
}


//
// Save the updated index files under `data/*`
//
function saveIndex() {
  const START = '🏗   ' + colors.yellow(`Saving index files...`);
  const END = '👍  ' + colors.green(`done saving`);
  console.log('');
  console.log(START);
  console.time(END);

  fileTree.write(_cache);

  console.timeEnd(END);
}


//
// mergeItems()
// Iterate over the names we are keeping and:
// - insert anything "new" (i.e. not matched by the matcher).
// - update all items to have whatever tags they should have.
//
function mergeItems() {
  const START = '🏗   ' + colors.yellow(`Merging items...`);
  const END = '👍  ' + colors.green(`done merging`);
  console.log('');
  console.log(START);
  console.time(END);


  Object.keys(_config.trees).forEach(t => {
    const tree = _config.trees[t];
    let total = 0;
    let totalNew = 0;

    //
    // INSERT - Look in `_keep` for new items not yet in the tree..
    //
    const keeping = _keep[t] || {};
    Object.keys(keeping).forEach(kvn => {
      const parts = kvn.split('|', 2);     // kvn = "key/value|name"
      const kv = parts[0];
      const n = parts[1];
      const parts2 = kv.split('/', 2);
      const k = parts2[0];
      const v = parts2[1];
      const tkv = `${t}/${k}/${v}`;

      const m = matcher.match(k, v, n);
      if (m) return;     // already in the index

      // A new item!
      let item = { tags: {} };
      item.displayName = n;
      item.locationSet = { include: ['001'] };   // the whole world
      item.tags[k] = v;     // assign default tag k=v

      // Perform tree-specific tag defaults here..
      if (t === 'brands') {
        item.tags.brand = n;
        item.tags.name = n;

      } else if (t === 'operators') {
        item.tags.operator = n;

      } else if (t === 'transit') {
        item.tags.network = n;
        item.tags.operator = n;
      }

      // Insert into index..
      if (!_cache.path[tkv])  _cache.path[tkv] = [];
      _cache.path[tkv].push(item);
      totalNew++;
    });


    //
    // UPDATE - Check all items in the tree for expected tags..
    //
    const paths = Object.keys(_cache.path).filter(tkv => tkv.split('/')[0] === t);
    paths.forEach(tkv => {
      let items = _cache.path[tkv];
      if (!Array.isArray(items) || !items.length) return;

      const parts = tkv.split('/', 3);     // tkv = "tree/key/value"
      const k = parts[1];
      const v = parts[2];
      const kv = `${k}/${v}`;

      items.forEach(item => {
        total++;
        let tags = item.tags;
        let name = '';   // which "name" we use for the locales check below

        // Perform tree-specific tag cleanups here..
        if (t === 'brands') {
          name = tags.brand || tags.name;

          // assign some default tags if missing
          if (kv === 'amenity/cafe') {
            if (!tags.takeaway)    tags.takeaway = 'yes';
            if (!tags.cuisine)     tags.cuisine = 'coffee_shop';
          } else if (kv === 'amenity/fast_food') {
            if (!tags.takeaway)    tags.takeaway = 'yes';
          } else if (kv === 'amenity/clinic') {
            if (!tags.healthcare)  tags.healthcare = 'clinic';
          } else if (kv === 'amenity/hopsital') {
            if (!tags.healthcare)  tags.healthcare = 'hopsital';
          } else if (kv === 'amenity/pharmacy') {
            if (!tags.healthcare)  tags.healthcare = 'pharmacy';
          }

        } else if (t === 'flags') {
          name = tags['flag:name'];

          // Sort the flags in the file according to their country of origin
          let country = tags.country || item.locationSet.include[0];
          if (typeof country === 'string' && country.length === 2) {
            const cc = country.toUpperCase();
            const re = new RegExp('^' + cc);   // leading country code
            if (!re.test(item.displayName)) {
              item.displayName = cc + ' - ' + item.displayName;
            }
          }

        } else if (t === 'operators') {
          name = tags.operator || tags.name || tags.brand;

          // Seed missing operator tags (for a file that we copied over from the 'brand' tree)
          Object.keys(tags).forEach(osmkey => {
            if (/brand/.test(osmkey)) {
              let operatorkey = osmkey.replace('brand', 'operator');   // copy `brand`->`operator`, `brand:ru`->`operator:ru`, etc.
              if (!tags[operatorkey]) tags[operatorkey] = tags[osmkey];
            }
          });

          // For certain 'operator' categories that are kind of like brands,
          // copy missing tags the other way too and include names
          //  (note: we can change this later of people hate it)
          // https://github.com/osmlab/name-suggestion-index/issues/2883#issuecomment-726305200
          if (/^amenity\/(bicycle|car)/.test(kv)) {
            Object.keys(tags).forEach(osmkey => {
              // an operator tag (but not `operator:type`)
              if (/operator(?!(:type))/.test(osmkey)) {
                let brandkey = osmkey.replace('operator', 'brand');  // copy `operator`->`brand`, `operator:ru`->`brand:ru`, etc.
                if (!tags[brandkey]) tags[brandkey] = tags[osmkey];
                if (!/wiki/.test(osmkey)) {
                  let namekey = osmkey.replace('operator', 'name');   // copy `operator`->`name`, `operator:ru`->`name:ru`, etc.
                  if (!tags[namekey]) tags[namekey] = tags[osmkey];
                }
              }
            });
          }

        } else if (t === 'transit') {
          name = tags.network;

          // If the operator is the same as the network, copy any missing *:wikipedia/*:wikidata tags
          if (tags.network && tags.operator && tags.network === tags.operator) {
            if (!tags['operator:wikidata'] && tags['network:wikidata'])    tags['operator:wikidata'] = tags['network:wikidata'];
            if (!tags['operator:wikipedia'] && tags['network:wikipedia'])  tags['operator:wikipedia'] = tags['network:wikipedia'];
            if (!tags['network:wikidata'] && tags['operator:wikidata'])    tags['network:wikidata'] = tags['operator:wikidata'];
            if (!tags['network:wikipedia'] && tags['operator:wikipedia'])  tags['network:wikipedia'] = tags['operator:wikipedia'];
          }
        }

        // If the name can only be reasonably read in one country,
        // assign `locationSet`, and localize tags like `name:xx`
        // https://www.regular-expressions.info/unicode.html
        if (/[\u0590-\u05FF]/.test(name)) {          // Hebrew
          // note: old ISO 639-1 lang code for Hebrew was `iw`, now `he`
          if (!item.locationSet)  item.locationSet = { include: ['il'] };
          setLanguageTags(tags, 'he');
        } else if (/[\u0E00-\u0E7F]/.test(name)) {   // Thai
          if (!item.locationSet)  item.locationSet = { include: ['th'] };
          setLanguageTags(tags, 'th');
        } else if (/[\u1000-\u109F]/.test(name)) {   // Myanmar
          if (!item.locationSet)  item.locationSet = { include: ['mm'] };
          setLanguageTags(tags, 'my');
        } else if (/[\u1100-\u11FF]/.test(name)) {   // Hangul
          if (!item.locationSet)  item.locationSet = { include: ['kr'] };
          setLanguageTags(tags, 'ko');
        } else if (/[\u1700-\u171F]/.test(name)) {   // Tagalog
          if (!item.locationSet)  item.locationSet = { include: ['ph'] };
          setLanguageTags(tags, 'tl');
        } else if (/[\u3040-\u30FF]/.test(name)) {   // Hirgana or Katakana
          if (!item.locationSet)  item.locationSet = { include: ['jp'] };
          setLanguageTags(tags, 'ja');
        } else if (/[\u3130-\u318F]/.test(name)) {   // Hangul
          if (!item.locationSet)  item.locationSet = { include: ['kr'] };
          setLanguageTags(tags, 'ko');
        } else if (/[\uA960-\uA97F]/.test(name)) {   // Hangul
          if (!item.locationSet)  item.locationSet = { include: ['kr'] };
          setLanguageTags(tags, 'ko');
        } else if (/[\uAC00-\uD7AF]/.test(name)) {   // Hangul
          if (!item.locationSet)  item.locationSet = { include: ['kr'] };
          setLanguageTags(tags, 'ko');
        } else {
          if (!item.locationSet)  item.locationSet = { include: ['001'] };   // the whole world
        }

        // Perform common tag cleanups here..
        Object.keys(tags).forEach(osmkey => {
          // `website` tag should be the website for that location, not the website for the brand..
          if (osmkey === 'website') {
            delete tags[osmkey];
            return;
          }

          // Replace QID/Wikipedia replacements
          const matchTag = osmkey.match(/^(\w+):wikidata$/);
          if (matchTag) {                         // Look at '*:wikidata' tags
            const wd = tags[osmkey];
            const replace = _config.replacements[wd];    // If it matches a QID in the replacement list...

            if (replace && replace.wikidata !== undefined) {   // replace or delete `*:wikidata` tag
              if (replace.wikidata) {
                tags[osmkey] = replace.wikidata;
              } else {
                delete tags[osmkey];
              }
            }
            if (replace && replace.wikipedia !== undefined) {  // replace or delete `*:wikipedia` tag
              const wpkey = matchTag[1] + ':wikipedia';
              if (replace.wikipedia) {
                tags[wpkey] = replace.wikipedia;
              } else {
                delete tags[wpkey];
              }
            }
          }
        });

        // regenerate id here, in case the locationSet has changed
        const locationID = loco.validateLocationSet(item.locationSet).id;
        item.id = idgen(item, tkv, locationID);
      });
    });

    console.log(`${tree.emoji}  ${t}:\t${total} total, ${totalNew} new`);

  });

  console.timeEnd(END);

  function setLanguageTags(tags, code) {
    if (tags.name)      tags[`name:${code}`] = tags.name;
    if (tags.brand)     tags[`brand:${code}`] = tags.brand;
    if (tags.operator)  tags[`operator:${code}`] = tags.operator;
    if (tags.network)   tags[`network:${code}`] = tags.network;
  }
}


//
// checkItems()
// Checks all the items for several kinds of issues
//
function checkItems(t) {
  console.log('');
  console.log('🏗   ' + colors.yellow(`Checking ${t}...`));

  const tree = _config.trees[t];
  const oddChars = /[\s=!"#%'*{},.\/:?\(\)\[\]@\\$\^*+<>«»~`’\u00a1\u00a7\u00b6\u00b7\u00bf\u037e\u0387\u055a-\u055f\u0589\u05c0\u05c3\u05c6\u05f3\u05f4\u0609\u060a\u060c\u060d\u061b\u061e\u061f\u066a-\u066d\u06d4\u0700-\u070d\u07f7-\u07f9\u0830-\u083e\u085e\u0964\u0965\u0970\u0af0\u0df4\u0e4f\u0e5a\u0e5b\u0f04-\u0f12\u0f14\u0f85\u0fd0-\u0fd4\u0fd9\u0fda\u104a-\u104f\u10fb\u1360-\u1368\u166d\u166e\u16eb-\u16ed\u1735\u1736\u17d4-\u17d6\u17d8-\u17da\u1800-\u1805\u1807-\u180a\u1944\u1945\u1a1e\u1a1f\u1aa0-\u1aa6\u1aa8-\u1aad\u1b5a-\u1b60\u1bfc-\u1bff\u1c3b-\u1c3f\u1c7e\u1c7f\u1cc0-\u1cc7\u1cd3\u200b-\u200f\u2016\u2017\u2020-\u2027\u2030-\u2038\u203b-\u203e\u2041-\u2043\u2047-\u2051\u2053\u2055-\u205e\u2cf9-\u2cfc\u2cfe\u2cff\u2d70\u2e00\u2e01\u2e06-\u2e08\u2e0b\u2e0e-\u2e16\u2e18\u2e19\u2e1b\u2e1e\u2e1f\u2e2a-\u2e2e\u2e30-\u2e39\u3001-\u3003\u303d\u30fb\ua4fe\ua4ff\ua60d-\ua60f\ua673\ua67e\ua6f2-\ua6f7\ua874-\ua877\ua8ce\ua8cf\ua8f8-\ua8fa\ua92e\ua92f\ua95f\ua9c1-\ua9cd\ua9de\ua9df\uaa5c-\uaa5f\uaade\uaadf\uaaf0\uaaf1\uabeb\ufe10-\ufe16\ufe19\ufe30\ufe45\ufe46\ufe49-\ufe4c\ufe50-\ufe52\ufe54-\ufe57\ufe5f-\ufe61\ufe68\ufe6a\ufe6b\ufeff\uff01-\uff03\uff05-\uff07\uff0a\uff0c\uff0e\uff0f\uff1a\uff1b\uff1f\uff20\uff3c\uff61\uff64\uff65]+/g;

  let warnMatched = matcher.getWarnings();
  let warnDuplicate = [];
  let warnFormatWikidata = [];
  let warnFormatWikipedia = [];
  let warnMissingTag = [];
  let warnFormatTag = [];
  let seenName = {};

  let total = 0;      // total items
  let totalWd = 0;    // total items with wikidata

  const paths = Object.keys(_cache.path).filter(tkv => tkv.split('/')[0] === t);
  const display = (val) => `${val.displayName} (${val.id})`;

  paths.forEach(tkv => {
    const items = _cache.path[tkv];
    if (!Array.isArray(items) || !items.length) return;

    const parts = tkv.split('/', 3);     // tkv = "tree/key/value"
    const k = parts[1];
    const v = parts[2];
    const kv = `${k}/${v}`;

    items.forEach(item => {
      const tags = item.tags;

      total++;
      if (tags[tree.mainTag]) totalWd++;

      // check tags
      Object.keys(tags).forEach(osmkey => {
        if (/:wikidata$/.test(osmkey)) {       // Check '*:wikidata' tags
          const wd = tags[osmkey];
          if (!/^Q\d+$/.test(wd)) {
            warnFormatWikidata.push([display(item), wd]);
          }
        }
        if (/:wikipedia$/.test(osmkey)) {      // Check '*.wikipedia' tags
          // So many contributors get the wikipedia tags wrong, so let's just reformat it for them.
          const wp = tags[osmkey] = decodeURIComponent(tags[osmkey]).replace(/_/g, ' ');
          if (!/^[a-z\-]{2,}:[^_]*$/.test(wp)) {
            warnFormatWikipedia.push([display(item), wp]);
          }
        }
      });

      // Warn on other missing tags
      switch (kv) {
        case 'amenity/clinic':
        case 'amenity/hospital':
        case 'amenity/pharmacy':
          if (!tags.healthcare) { warnMissingTag.push([display(item), 'healthcare']); }
          break;
        case 'amenity/gambling':
        case 'leisure/adult_gaming_centre':
          if (!tags.gambling) { warnMissingTag.push([display(item), 'gambling']); }
          break;
        case 'amenity/fast_food':
        case 'amenity/restaurant':
          if (!tags.cuisine) { warnMissingTag.push([display(item), 'cuisine']); }
          break;
        case 'amenity/vending_machine':
          if (!tags.vending) { warnMissingTag.push([display(item), 'vending']); }
          break;
        case 'man_made/flagpole':
          if (!tags['flag:type']) { warnMissingTag.push([display(item), 'flag:type']); }
          if (!tags['subject']) { warnMissingTag.push([display(item), 'subject']); }
          if (!tags['subject:wikidata']) { warnMissingTag.push([display(item), 'subject:wikidata']); }
          break;
        case 'shop/beauty':
          if (!tags.beauty) { warnMissingTag.push([display(item), 'beauty']); }
          break;
      }

      // Warn if OSM tags contain odd punctuation or spacing..
      ['cuisine', 'vending', 'beauty', 'gambling'].forEach(osmkey => {
        const val = tags[osmkey];
        if (val && oddChars.test(val)) {
          warnFormatTag.push([display(item), `${osmkey} = ${val}`]);
        }
      });
      // Warn if a semicolon-delimited multivalue has snuck into the index
      ['name', 'brand', 'operator', 'network'].forEach(osmkey => {
        const val = tags[osmkey];
        if (val && /;/.test(val)) {
          warnFormatTag.push([display(item), `${osmkey} = ${val}`]);
        }
      });
      // Warn if user put `wikidata`/`wikipedia` instead of `brand:wikidata`/`brand:wikipedia`
      ['wikipedia', 'wikidata'].forEach(osmkey => {
        const val = tags[osmkey];
        if (val) {
          warnFormatTag.push([display(item), `${osmkey} = ${val}`]);
        }
      });


// TODO ?
  //     // Warn about "new" (no wikidata) items that may duplicate an "existing" (has wikidata) item.
  //     // The criteria for this warning is:
  //     // - One of the items has no `brand:wikidata`
  //     // - The items have nearly the same name
  //     // - The items have the same locationSet (or the one without wikidata is worldwide)
  //     const name = tags.name || tags.brand;
  //     const stem = stemmer(name) || name;
  //     const itemwd = tags[tree.mainTag];
  //     const itemls = loco.validateLocationSet(item.locationSet).id;

  //     if (!seenName[stem]) seenName[stem] = new Set();
  //     seenName[stem].add(item);

  //     if (seenName[stem].size > 1) {
  //       seenName[stem].forEach(other => {
  //         if (other.id === item.id) return;   // skip self
  //         const otherwd = other.tags[tree.mainTag];
  //         const otherls = loco.validateLocationSet(other.locationSet).id;

  //         // pick one of the items without a wikidata tag to be the "duplicate"
  //         if (!itemwd && (itemls === otherls || itemls === '+[Q2]')) {
  //           warnDuplicate.push([display(item), display(other)]);
  //         } else if (!otherwd && (otherls === itemls || otherls === '+[Q2]')) {
  //           warnDuplicate.push([display(other), display(item)]);
  //         }
  //       });
  //     }

    });
  });

  if (warnMatched.length) {
    console.warn(colors.yellow('\n⚠️   Warning - Ambiguous matches:'));
    console.warn(colors.gray('-').repeat(70));
    console.warn(colors.gray('  If the items are the different, make sure they have different locationSets (e.g. "us", "ca"'));
    console.warn(colors.gray('  If the items are the same, remove extra `matchTags` or `matchNames`.  Remember:'));
    console.warn(colors.gray('  - Name matching ignores letter case, punctuation, spacing, and diacritical marks (é vs e). '));
    console.warn(colors.gray('    No need to add `matchNames` for variations in these.'));
    console.warn(colors.gray('  - Tag matching automatically includes other similar tags in the same match group.'));
    console.warn(colors.gray('    No need to add `matchTags` for similar tags.  see `config/matchGroups.json`'));
    console.warn(colors.gray('-').repeat(70));
    warnMatched.forEach(w => console.warn(
      colors.yellow('  "' + w[0] + '"') + ' -> matches? -> ' + colors.yellow('"' + w[1] + '"')
    ));
    console.warn('total ' + warnMatched.length);
  }

  if (warnMissingTag.length) {
    console.warn(colors.yellow('\n⚠️   Warning - Missing tag:'));
    console.warn(colors.gray('-').repeat(70));
    console.warn(colors.gray('  To resolve these, add the missing tag.'));
    console.warn(colors.gray('-').repeat(70));
    warnMissingTag.forEach(w => console.warn(
      colors.yellow('  "' + w[0] + '"') + ' -> missing tag? -> ' + colors.yellow('"' + w[1] + '"')
    ));
    console.warn('total ' + warnMissingTag.length);
  }

  if (warnFormatTag.length) {
    console.warn(colors.yellow('\n⚠️   Warning - Unusual OpenStreetMap tag:'));
    console.warn(colors.gray('-').repeat(70));
    console.warn(colors.gray('  To resolve these, make sure the OpenStreetMap tag is correct.'));
    console.warn(colors.gray('-').repeat(70));
    warnFormatTag.forEach(w => console.warn(
      colors.yellow('  "' + w[0] + '"') + ' -> unusual tag? -> ' + colors.yellow('"' + w[1] + '"')
    ));
    console.warn('total ' + warnFormatTag.length);
  }

  if (warnDuplicate.length) {
    console.warn(colors.yellow('\n⚠️   Warning - Potential duplicate:'));
    console.warn(colors.gray('-').repeat(70));
    console.warn(colors.gray('  If the items are two different businesses,'));
    console.warn(colors.gray('    make sure they both have accurate locationSets (e.g. "us"/"ca") and wikidata identifiers.'));
    console.warn(colors.gray('  If the items are duplicates of the same business,'));
    console.warn(colors.gray('    add `matchTags`/`matchNames` properties to the item that you want to keep, and delete the unwanted item.'));
    console.warn(colors.gray('  If the duplicate item is a generic word,'));
    console.warn(colors.gray('    add a filter to config/filter_brands.json and delete the unwanted item.'));
    console.warn(colors.gray('-').repeat(70));
    warnDuplicate.forEach(w => console.warn(
      colors.yellow('  "' + w[0] + '"') + ' -> duplicates? -> ' + colors.yellow('"' + w[1] + '"')
    ));
    console.warn('total ' + warnDuplicate.length);
  }

  if (warnFormatWikidata.length) {
    console.warn(colors.yellow('\n⚠️   Warning - Incorrect `wikidata` format:'));
    console.warn(colors.gray('-').repeat(70));
    console.warn(colors.gray('  To resolve these, make sure "*:wikidata" tag looks like "Q191615".'));
    console.warn(colors.gray('-').repeat(70));
    warnFormatWikidata.forEach(w => console.warn(
      colors.yellow('  "' + w[0] + '"') + ' -> "*:wikidata": ' + '"' + w[1] + '"'
    ));
    console.warn('total ' + warnFormatWikidata.length);
  }

  if (warnFormatWikipedia.length) {
    console.warn(colors.yellow('\n⚠️   Warning - Incorrect `wikipedia` format:'));
    console.warn(colors.gray('-').repeat(70));
    console.warn(colors.gray('  To resolve these, make sure "*:wikipedia" tag looks like "en:Pizza Hut".'));
    console.warn(colors.gray('-').repeat(70));
    warnFormatWikipedia.forEach(w => console.warn(
      colors.yellow('  "' + w[0] + '"') + ' -> "*:wikipedia": ' + '"' + w[1] + '"'
    ));
    console.warn('total ' + warnFormatWikipedia.length);
  }

  const pctWd = total > 0 ? (totalWd * 100 / total).toFixed(1) : 0;

  console.log('');
  console.info(colors.blue.bold(`${tree.emoji}  ${t}/* completeness:`));
  console.info(colors.blue.bold(`    ${total} total`));
  console.info(colors.blue.bold(`    ${totalWd} (${pctWd}%) with a '${tree.mainTag}' tag`));
}
