/**
 * ANSIR RO-Crate Metadata Generator
 *
 * Reads data/data.json (after DOI enrichment) and generates a standards-compliant
 * ro-crate-metadata.json following the RO-Crate 1.1 specification.
 *
 * Each ANSIR project becomes a Dataset entity in the @graph, with contextual
 * entities for people (with ORCIDs), organisations, places, funding, instruments,
 * and linked publications/datasets.
 *
 * Specification: https://www.researchobject.org/ro-crate/specification/1.1/
 *
 * Usage: node scripts/generate-ro-crate.js
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'data.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'ro-crate-metadata.json');

// The facility's page on the AuScope site. ansir.org.au does not exist
// (NXDOMAIN) and must not be used as an identifier: RO-Crate @id values
// are meant to resolve for harvesters that follow them.
const ANSIR_URL = 'https://www.auscope.org.au/ansir';
const AUSCOPE_URL = 'https://www.auscope.org.au';
const GITHUB_PAGES_URL = 'https://auscope.github.io/ansir/';

/**
 * Generate a local @id for contextual entities
 */
function localId(prefix, value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  return `#${prefix}-${slug}`;
}

/**
 * Extract clean DOI from identifier
 */
function extractDOI(identifier) {
  if (!identifier) return null;
  const match = String(identifier).trim().match(
    /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,}\/[^\s]+)/i
  );
  return match ? `https://doi.org/${match[1]}` : null;
}

/**
 * Build the RO-Crate @graph from ANSIR data
 */
function buildGraph(data) {
  const graph = [];
  const entityMap = new Map(); // Track entities by @id to avoid duplicates

  function addEntity(entity) {
    if (!entityMap.has(entity['@id'])) {
      entityMap.set(entity['@id'], entity);
      graph.push(entity);
    }
    return { '@id': entity['@id'] };
  }

  // --- 1. RO-Crate Metadata File Descriptor (required) ---
  graph.push({
    '@id': 'ro-crate-metadata.json',
    '@type': 'CreativeWork',
    'conformsTo': { '@id': 'https://w3id.org/ro/crate/1.1' },
    'about': { '@id': './' }
  });

  // --- 2. ANSIR organisation (contextual entity) ---
  const ansirRef = addEntity({
    '@id': ANSIR_URL,
    '@type': 'Organization',
    'name': 'ANSIR Research Facilities for Earth Sounding (ANSIR)',
    'url': ANSIR_URL,
    'parentOrganization': { '@id': AUSCOPE_URL }
  });

  addEntity({
    '@id': AUSCOPE_URL,
    '@type': 'Organization',
    'name': 'AuScope Ltd',
    'url': AUSCOPE_URL
  });

  // --- 3. Root Data Entity (the collection) ---
  const projectRefs = [];
  const projects = data.data || [];

  // Process each project
  for (const project of projects) {
    const projectId = `#project-${project.ansirCode || project.id}`;
    const projectEntity = {
      '@id': projectId,
      '@type': ['Dataset', 'Project'],
      'name': project.title || '',
      'description': project.description || '',
      'identifier': project.ansirCode || '',
      'url': `${GITHUB_PAGES_URL}?id=${encodeURIComponent(project.ansirCode || project.id)}`
    };

    // Status
    if (project.status) {
      projectEntity.creativeWorkStatus = project.status;
    }

    // Dates
    if (project.startDate) {
      projectEntity.dateCreated = project.startDate;
    }
    if (project.startDate && project.endDate) {
      projectEntity.temporalCoverage = `${project.startDate}/${project.endDate}`;
    } else if (project.startDate) {
      projectEntity.temporalCoverage = `${project.startDate}/..`;
    }

    // Keywords
    if (project.keywords && project.keywords.length > 0) {
      projectEntity.keywords = Array.isArray(project.keywords)
        ? project.keywords.join(', ')
        : project.keywords;
    }

    // Methods as DefinedTerm entities
    if (project.methods && project.methods.length > 0) {
      projectEntity.about = project.methods.map(method => {
        const methodId = localId('method', method);
        addEntity({
          '@id': methodId,
          '@type': 'DefinedTerm',
          'name': method
        });
        return { '@id': methodId };
      });
    }

    // Location / spatial coverage
    const loc = project.location || {};
    if (loc.coordinates || loc.region) {
      const placeId = localId('place', project.ansirCode || project.id);
      const placeEntity = {
        '@id': placeId,
        '@type': 'Place',
        'name': [loc.region, loc.country].filter(Boolean).join(', ')
      };

      // Parse coordinates
      if (loc.coordinates) {
        const parts = String(loc.coordinates).split(',').map(s => s.trim());
        if (parts.length >= 2 && !isNaN(parseFloat(parts[0]))) {
          const geoId = localId('geo', project.ansirCode || project.id);
          addEntity({
            '@id': geoId,
            '@type': 'GeoCoordinates',
            'latitude': parseFloat(parts[0]),
            'longitude': parseFloat(parts[1])
          });
          placeEntity.geo = { '@id': geoId };
        }
      }

      // Parse polygon
      if (loc.polygon && loc.polygon.includes(',')) {
        const coords = loc.polygon.split(';').map(pair => {
          const c = pair.trim().split(',');
          return c.length >= 2 ? `${c[0].trim()} ${c[1].trim()}` : null;
        }).filter(Boolean);
        if (coords.length > 2) {
          const shapeId = localId('shape', project.ansirCode || project.id);
          addEntity({
            '@id': shapeId,
            '@type': 'GeoShape',
            'polygon': coords.join(' ')
          });
          placeEntity.geo = placeEntity.geo
            ? [placeEntity.geo, { '@id': shapeId }]
            : { '@id': shapeId };
        }
      }

      addEntity(placeEntity);
      projectEntity.spatialCoverage = { '@id': placeId };
    }

    // Contributors
    if (project.contributors && project.contributors.length > 0) {
      const creatorRefs = [];

      for (const contrib of project.contributors) {
        if (!contrib.name) continue;

        // Use ORCID as @id if available, otherwise generate local id
        const personId = contrib.orcid && contrib.orcid.includes('orcid.org')
          ? contrib.orcid
          : localId('person', contrib.name);

        const personEntity = {
          '@id': personId,
          '@type': 'Person',
          'name': [contrib.title, contrib.name].filter(Boolean).join(' ')
        };

        if (contrib.orcid && contrib.orcid.includes('orcid.org')) {
          personEntity.identifier = contrib.orcid;
        }

        // Organisation affiliation (use ROR as @id when available)
        if (contrib.organisation) {
          const orgId = contrib.organisationRor && contrib.organisationRor.includes('ror.org')
            ? contrib.organisationRor
            : localId('org', contrib.organisation);
          const orgEntity = {
            '@id': orgId,
            '@type': 'Organization',
            'name': contrib.organisation
          };
          if (contrib.organisationRor && contrib.organisationRor.includes('ror.org')) {
            orgEntity.identifier = contrib.organisationRor;
          }
          addEntity(orgEntity);
          personEntity.affiliation = { '@id': orgId };
        }

        addEntity(personEntity);
        creatorRefs.push({ '@id': personId });
      }

      if (creatorRefs.length > 0) {
        projectEntity.creator = creatorRefs;
      }
    }

    // Funding
    if (project.funding && project.funding.length > 0) {
      const funderRefs = [];

      for (const fund of project.funding) {
        if (!fund.agency && !fund.title) continue;

        const grantId = localId('grant', fund.identifier || fund.title || fund.agency);
        const grantEntity = {
          '@id': grantId,
          '@type': 'Grant',
          'name': fund.title || ''
        };

        if (fund.identifier) {
          grantEntity.identifier = fund.identifier;
        }

        if (fund.agency) {
          const funderOrgId = fund.agencyRor && fund.agencyRor.includes('ror.org')
            ? fund.agencyRor
            : localId('funder', fund.agency);
          const funderEntity = {
            '@id': funderOrgId,
            '@type': 'Organization',
            'name': fund.agency
          };
          if (fund.agencyRor && fund.agencyRor.includes('ror.org')) {
            funderEntity.identifier = fund.agencyRor;
          }
          addEntity(funderEntity);
          grantEntity.funder = { '@id': funderOrgId };
        }

        addEntity(grantEntity);
        funderRefs.push({ '@id': grantId });
      }

      if (funderRefs.length > 0) {
        projectEntity.funding = funderRefs;
      }
    }

    // Instruments
    if (project.instruments && project.instruments.length > 0) {
      projectEntity.instrument = project.instruments.map(inst => {
        const instId = localId('instrument', inst.name);
        addEntity({
          '@id': instId,
          '@type': 'IndividualProduct',
          'name': inst.name,
          'description': `${inst.count} unit${inst.count !== 1 ? 's' : ''} deployed`
        });
        return { '@id': instId };
      });
    }

    // Related objects (publications, datasets, FDSN networks)
    if (project.relatedObjects && project.relatedObjects.length > 0) {
      const citations = [];
      const parts = [];

      for (const obj of project.relatedObjects) {
        const doiUrl = extractDOI(obj.identifier);
        const objId = doiUrl || obj.identifier;
        if (!objId) continue;

        const type = (obj.type || '').toLowerCase();

        if (type.includes('journal') || type.includes('article') || type.includes('publication')) {
          // Publication / scholarly article
          const pubEntity = {
            '@id': objId,
            '@type': 'ScholarlyArticle'
          };
          if (obj.title) pubEntity.name = obj.title;
          if (obj.authors) pubEntity.author = obj.authors;
          if (obj.year) pubEntity.datePublished = obj.year;
          if (obj.journal) {
            const journalId = localId('journal', obj.journal);
            addEntity({
              '@id': journalId,
              '@type': 'Periodical',
              'name': obj.journal
            });
            pubEntity.isPartOf = { '@id': journalId };
          }
          if (doiUrl) pubEntity.identifier = doiUrl;

          addEntity(pubEntity);
          citations.push({ '@id': objId });

        } else if (type.includes('fdsn') || type.includes('network')) {
          // FDSN network — a sub-dataset
          const networkEntity = {
            '@id': objId,
            '@type': 'Dataset'
          };
          if (obj.title) networkEntity.name = obj.title;
          if (obj.authors) networkEntity.author = obj.authors;
          if (obj.year) networkEntity.datePublished = obj.year;
          if (obj.journal) networkEntity.publisher = obj.journal;
          if (doiUrl) networkEntity.identifier = doiUrl;

          addEntity(networkEntity);
          parts.push({ '@id': objId });

        } else {
          // Dataset or other
          const dataEntity = {
            '@id': objId,
            '@type': 'Dataset'
          };
          if (obj.title) dataEntity.name = obj.title;
          if (obj.authors) dataEntity.author = obj.authors;
          if (obj.year) dataEntity.datePublished = obj.year;
          if (doiUrl) dataEntity.identifier = doiUrl;

          addEntity(dataEntity);
          parts.push({ '@id': objId });
        }
      }

      if (citations.length > 0) {
        projectEntity.citation = citations;
      }
      if (parts.length > 0) {
        projectEntity.hasPart = parts;
      }
    }

    // Data access
    if (project.dataAccess) {
      projectEntity.conditionsOfAccess = project.dataAccess;
    }

    // Indigenous engagement
    if (project.indigenousInvolvement) {
      const notes = [
        project.indigenousEngagement,
        project.indigenousAcknowledgement
      ].filter(Boolean).join('. ');
      if (notes) {
        projectEntity.ethicsPolicy = notes;
      }
    }

    // Provider
    projectEntity.provider = ansirRef;

    // License
    projectEntity.license = { '@id': 'https://creativecommons.org/licenses/by/4.0/' };

    addEntity(projectEntity);
    projectRefs.push({ '@id': projectId });
  }

  // Add license entity
  addEntity({
    '@id': 'https://creativecommons.org/licenses/by/4.0/',
    '@type': 'CreativeWork',
    'name': 'Creative Commons Attribution 4.0 International',
    'description': 'This license allows reusers to distribute, remix, adapt, and build upon the material in any medium or format, so long as attribution is given to the creator.',
    'identifier': 'CC-BY-4.0'
  });

  // Root Data Entity — the collection
  const rootEntity = {
    '@id': './',
    '@type': 'Dataset',
    'name': 'ANSIR Research Projects Database',
    'description': 'Public database of geophysical research projects enabled by the ANSIR Research Facilities for Earth Sounding (ANSIR), an AuScope national facility. Includes seismic, magnetotelluric, and DAS deployments across Australia and internationally.',
    'datePublished': data.exported ? data.exported.split('T')[0] : new Date().toISOString().split('T')[0],
    'license': { '@id': 'https://creativecommons.org/licenses/by/4.0/' },
    'provider': ansirRef,
    'publisher': { '@id': AUSCOPE_URL },
    'url': GITHUB_PAGES_URL,
    'hasPart': projectRefs
  };

  // Insert root entity after the descriptor (position 1)
  graph.splice(1, 0, rootEntity);

  return graph;
}

/**
 * Main
 */
function main() {
  console.log('Reading data/data.json...');
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);

  if (!data.data || !Array.isArray(data.data)) {
    console.log('No project data found.');
    process.exit(0);
  }

  console.log(`Generating RO-Crate for ${data.data.length} projects...`);
  const graph = buildGraph(data);

  const roCrate = {
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@graph': graph
  };

  const output = JSON.stringify(roCrate, null, 2);
  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');

  const entityCount = graph.length;
  const projectCount = graph.filter(e => e['@id'] && e['@id'].startsWith('#project-')).length;
  console.log(`Done. Generated ro-crate-metadata.json with ${entityCount} entities (${projectCount} projects).`);
}

main();
