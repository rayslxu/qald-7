"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LABEL = exports.PROPERTY_PREFIX = exports.ENTITY_PREFIX = void 0;
const Tp = __importStar(require("thingpedia"));
const sqlite3 = __importStar(require("sqlite3"));
const fs = __importStar(require("fs"));
const wikibase_sdk_1 = __importDefault(require("wikibase-sdk"));
const URL = 'https://query.wikidata.org/sparql';
exports.ENTITY_PREFIX = 'http://www.wikidata.org/entity/';
exports.PROPERTY_PREFIX = 'http://www.wikidata.org/prop/direct/';
exports.LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SQLITE_SCHEMA = `
create table http_requests (
    url text primary key,
    result text
);

create table labels (
    id varchar(16) primary key,
    label text
);
`;
function normalizeURL(url) {
    return url.trim().replace(/\s+/g, ' ');
}
class WikidataUtils {
    constructor(cachePath) {
        this._cachePath = cachePath;
        this._wdk = (0, wikibase_sdk_1.default)({ instance: 'https://www.wikidata.org' });
        this._cacheLoaded = false;
    }
    /**
     * Load or create sqlite database for caching
     */
    async _loadOrCreateSqliteCache() {
        const db = new sqlite3.Database(this._cachePath, sqlite3.OPEN_CREATE | sqlite3.OPEN_READWRITE);
        db.serialize(() => {
            if (!fs.existsSync(this._cachePath))
                db.exec(SQLITE_SCHEMA);
        });
        this._cache = db;
    }
    /**
     * Get cache
     * @param table the name of the table
     * @param field the filed of projection
     * @param constraint the constraint to apply to the retrieval
     * @returns undefined if not found, otherwise in the format of { result : string }
     */
    async _getCache(table, field, constraint) {
        if (!this._cacheLoaded)
            await this._loadOrCreateSqliteCache();
        return new Promise((resolve, reject) => {
            const sql = `select ${field} from ${table} where ${constraint.key} = ?`;
            this._cache.get(sql, constraint.value, (err, rows) => {
                if (err)
                    reject(err);
                else
                    resolve(rows);
            });
        });
    }
    /**
     * Set cache
     * @param table the name of the table
     * @param values all the values to add to the table
     * @returns undefined
     */
    async _setCache(table, ...values) {
        if (!this._cacheLoaded)
            await this._loadOrCreateSqliteCache();
        return new Promise((resolve, reject) => {
            const placeholders = values.map(() => '?').join(',');
            const sql = `insert into ${table} values (${placeholders})`;
            this._cache.get(sql, ...values, (err, rows) => {
                if (err)
                    reject(err);
                else
                    resolve(rows);
            });
        });
    }
    /**
     * Obtain results of a SPARQL query against Wikidata SPARQL endpoint
     * @param sparql a SPARQL query
     * @returns A list of the results
     */
    async _query(sparql) {
        const result = await this._request(`${URL}?query=${encodeURIComponent(normalizeURL(sparql))}`);
        return result.results.bindings;
    }
    /**
     * Obtain results of URL in JSON form (Wikibase API call)
     * @param url
     * @param caching enable caching for the request or not
     * @returns An object of the result
     */
    async _request(url, caching = true) {
        if (caching) {
            const cached = await this._getCache('http_requests', 'result', { key: 'url', value: url });
            if (cached)
                return JSON.parse(cached.result);
        }
        try {
            const result = await Tp.Helpers.Http.get(url, { accept: 'application/json' });
            if (caching)
                await this._setCache('http_requests', url, result);
            const parsed = JSON.parse(result);
            return parsed;
        }
        catch (e) {
            console.log(`Failed to retrieve result for: ${url}`);
            console.log(e);
            return null;
        }
    }
    /**
     * Obtain the values of property for a given entity
     * @param entityId QID of an entity
     * @param propertyId PID of an entity
     * @returns values of the property
     */
    async getPropertyValue(entityId, propertyId) {
        const sparql = `SELECT ?v WHERE { wd:${entityId} wdt:${propertyId} ?v. }`;
        const res = await this._query(sparql);
        return res.map((r) => r.v.value.slice(exports.ENTITY_PREFIX.length));
    }
    /**
     * Get the domain of a given entity:
     * if there are multiple domains, pick the one that has the most instances;
     * we skip this on human (Q5) and taxon (Q16521) domain, since the query will timeout
     * @param entityId QID of an entity
     * @returns
     */
    async getDomain(entityId) {
        const domains = await this.getPropertyValue(entityId, 'P31');
        if (domains.length === 0)
            return null;
        if (domains.length === 1)
            return domains[0];
        if (domains.includes('Q5'))
            return 'Q5';
        if (domains.includes('Q16521'))
            return 'Q16521';
        const sparql = `SELECT ?v (COUNT(?s) as ?count) WHERE {
            wd:${entityId} wdt:P31 ?v.
            ?s wdt:P31 ?v.
        } GROUP BY ?v ORDER BY DESC(?count)`;
        const res = await this._query(sparql);
        return res[0].v.value.slice(exports.ENTITY_PREFIX.length);
    }
    /**
     * Get the Wikidata label for an entity or a property
     * @param id QID or PID
     * @returns natural language label in English
     */
    async getLabel(id) {
        const result = await this._request(this._wdk.getEntities({
            ids: [id],
            languages: ['en'],
            props: ['labels']
        }));
        try {
            return Object.values(result.entities)[0].labels.en.value;
        }
        catch (e) {
            console.log(`Failed to retrieve label for ${id}`);
            return null;
        }
    }
    /**
     * Get the wikidata label for a list of entities/properties.
     * The API allows up to 50 entities/properties at a time.
     * @param qids a list of QIDs or PIDs
     * @returns A map from id to label
     */
    async getLabelsByBatch(...ids) {
        var _a, _b, _c, _d, _e;
        const result = {};
        const uncached = [];
        for (const id of ids) {
            const cached = await this._getCache('labels', 'label', { key: 'id', value: id });
            if (cached)
                result[id] = cached.label;
            else
                uncached.push(id);
        }
        const uniqueUncached = [...new Set(uncached)];
        for (let i = 0; i < uniqueUncached.length; i += 50) {
            const batch = uniqueUncached.slice(i, i + 50);
            const raw = await this._request(this._wdk.getEntities({
                ids: batch,
                languages: ['en'],
                props: ['labels']
            }));
            for (const [qid, entity] of Object.entries(raw.entities)) {
                if (qid !== entity.id) // some entities are simply a redirect of another entity, drop those 
                    continue;
                result[qid] = (_b = (_a = entity.labels) === null || _a === void 0 ? void 0 : _a.en) === null || _b === void 0 ? void 0 : _b.value;
                await this._setCache('labels', qid, (_e = (_d = (_c = entity.labels) === null || _c === void 0 ? void 0 : _c.en) === null || _d === void 0 ? void 0 : _d.value) !== null && _e !== void 0 ? _e : null);
            }
        }
        return result;
    }
    /**
     * Get example entities for the given domain
     *
     * Examples are sorted based on sitelinks.
     * Order by sitelinks in human (Q5) and taxon (Q16521) domain will lead to timeout,
     * thus handle these two domains specially
     *
     * @param domain QID of the domain
     * @param limit the maximum number of entities to return
     * @returns an array of QIDs belongs to the given domain
     */
    async getEntitiesByDomain(domain, limit = 100) {
        let sparql;
        if (['Q16521', 'Q5'].includes(domain)) {
            sparql = `SELECT ?v ?sitelinks WHERE {
                ?v wdt:P31 wd:${domain} ;
                   wikibase:sitelinks ?sitelinks . 
                FILTER (?sitelinks > 100) .
            } LIMIT ${limit}`;
        }
        else {
            sparql = `SELECT ?v WHERE {
                ?v wdt:P31 wd:${domain} ;
                   wikibase:sitelinks ?sitelinks .  
            } ORDER BY DESC(?sitelinks) LIMIT ${limit}`;
        }
        const res = await this._query(sparql);
        return res.map((r) => r.v.value.slice(exports.ENTITY_PREFIX.length));
    }
    /**
     * Get properties for a given domain
     *
     * First get 100 example entities in the domain, and then extract all properties
     * they use
     *
     * @param domain QID of the domain
     * @param includeNonEntityProperties include properties whose values are not Wikidata entities
     * @returns an array of PIDs belongs to the given domain
     */
    async getDomainProperties(domain, includeNonEntityProperties = false) {
        const properties = new Set();
        const exampleEntities = await this.getEntitiesByDomain(domain);
        const entityOnlyFilter = `FILTER(STRSTARTS(STR(?v), "${exports.ENTITY_PREFIX}")) .`;
        for (const entity of exampleEntities) {
            const sparql = `SELECT DISTINCT ?p WHERE {
                wd:${entity} ?p ?v .
                FILTER(STRSTARTS(STR(?p), "${exports.PROPERTY_PREFIX}")) . 
                ${includeNonEntityProperties ? '' : entityOnlyFilter}
            } `;
            const res = await this._query(sparql);
            res.forEach((r) => {
                if (r.p.value !== exports.PROPERTY_PREFIX + 'P31')
                    properties.add(r.p.value.slice(exports.PROPERTY_PREFIX.length));
            });
        }
        return Array.from(properties);
    }
    /**
     * Get properties and their values for a given domain
     *
     * First get 100 example entities in the domain, and then extract all properties
     * they use and their values
     *
     * @param domain QID of the domain
     * @param includeNonEntityProperties include properties whose values are not Wikidata entities
     * @returns an object where key is property PID, values are either an array of string/entity objects, or a type
     */
    async getDomainPropertiesAndValues(domain, includeNonEntityProperties = false) {
        const properties = {};
        const exampleEntities = await this.getEntitiesByDomain(domain);
        const entityOnlyFilter = `FILTER(STRSTARTS(STR(?v), "${exports.ENTITY_PREFIX}")) .`;
        for (const entity of exampleEntities) {
            const sparql = `SELECT DISTINCT ?p ?v WHERE {
                wd:${entity} ?p ?v .
                FILTER(STRSTARTS(STR(?p), "${exports.PROPERTY_PREFIX}")) . 
                ${includeNonEntityProperties ? '' : entityOnlyFilter}
            } `;
            const res = await this._query(sparql);
            res.forEach((r) => {
                if (!r.v.value.startsWith(exports.ENTITY_PREFIX) || r.p.value === exports.PROPERTY_PREFIX + 'P31')
                    return;
                const property = r.p.value.slice(exports.PROPERTY_PREFIX.length);
                const value = r.v.value.slice(exports.ENTITY_PREFIX.length);
                if (!(property in properties))
                    properties[property] = [];
                properties[property].push(value);
            });
        }
        return properties;
    }
}
exports.default = WikidataUtils;
//# sourceMappingURL=wikidata.js.map