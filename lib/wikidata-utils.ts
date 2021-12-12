import * as Tp from 'thingpedia';
import * as sqlite3 from 'sqlite3';
import * as fs from 'fs';
import { wikibaseSdk } from 'wikibase-sdk'; 
import wikibase from 'wikibase-sdk';

const URL = 'https://query.wikidata.org/sparql';
const ENTITY_PREFIX = 'http://www.wikidata.org/entity/';

const SQLITE_SCHEMA = `
create table cache (
    url text not null,
    result text not null
);`;

interface Cache {
    result : string
}

export default class WikidataUtils {
    private _wdk : wikibaseSdk;
    private _cache ! : sqlite3.Database;
    private _cacheLoaded : boolean;

    constructor() {
        this._wdk = wikibase({ instance: 'https://www.wikidata.org' });
        this._cacheLoaded = false;
    }

    /**
     * Load or create sqlite database for caching
     */
    private async _loadOrCreateSqliteCache() {
        const filename = 'wikidata_cache.sqlite';
        const db = new sqlite3.Database(filename, sqlite3.OPEN_CREATE|sqlite3.OPEN_READWRITE);
        db.serialize(() => {
            if (!fs.existsSync(filename)) 
                db.run(SQLITE_SCHEMA);
        });
        this._cache = db;
    }

    /**
     * Get cache 
     * @param url the url of the request
     * @returns undefined if not found, otherwise in the format of { result : string }
     */
    private async _getCache(url : string) : Promise<Cache|undefined> {
        if (!this._cacheLoaded) 
            await this._loadOrCreateSqliteCache();
        return new Promise((resolve, reject) => {
            const sql = `select result from cache where url = ?`;
            this._cache.get(sql, url, (err : Error|null, rows : any) => {
                if (err)
                    reject(err);
                else
                    resolve(rows);
            });
        });
    }

    private async _setCache(url : string, result : string) {
        if (!this._cacheLoaded) 
            await this._loadOrCreateSqliteCache();
        return new Promise((resolve, reject) => {
            const sql = `insert into cache values (?,?)`;
            this._cache.get(sql, url, result, (err : Error|null, rows : any) => {
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
    private async _query(sparql : string) {
        const result = await this._request(`${URL}?query=${encodeURIComponent(sparql)}`);
        return result.results.bindings;
    }

    /**
     * Obtain results of URL in JSON form (Wikibase API call)
     * @param url 
     * @returns An object of the result
     */
    private async _request(url : string) {
        const cached = await this._getCache(url);
        if (cached) 
            return JSON.parse(cached.result);
        try {
            const result = await Tp.Helpers.Http.get(url, { accept: 'application/json' });
            await this._setCache(url, result);
            const parsed = JSON.parse(result);
            return parsed;
        } catch(e) {
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
    async getPropertyValue(entityId : string, propertyId : string) : Promise<string[]> {
        const sparql = `SELECT ?v WHERE { wd:${entityId} wdt:${propertyId} ?v. } `;
        const res = await this._query(sparql);
        return res.map((r : any) => r.v.value.slice(ENTITY_PREFIX.length));
    }

    /**
     * Get the domain of a given entity: 
     * if there are multiple domains, pick the one that has the most instances;
     * we skip this on human (Q5) domain, since the query will timeout 
     * @param entityId QID of an entity
     * @returns 
     */
    async getDomain(entityId : string) : Promise<string|null> {
        const domains = await this.getPropertyValue(entityId, 'P31');
        if (domains.length === 0)
            return null;
        if (domains.length === 1)
            return domains[0];
        if (domains.includes('Q5'))
            return 'Q5';
        
        const sparql = `SELECT ?v (COUNT(?s) as ?count) WHERE {
            wd:${entityId} wdt:P31 ?v.
            ?s wdt:P31 ?v.
        } GROUP BY ?v ORDER BY DESC(?count)`;
        const res = await this._query(sparql);
        return res[0].v.value.slice(ENTITY_PREFIX.length);
    }

    /**
     * Get the Wikidata label for an entity or a property   
     * @param id QID or PID
     * @returns natural language label in English
     */
    async getLabel(id : string) : Promise<string> {
        const result = await this._request(this._wdk.getEntities({ 
            ids: [id],
            languages: ['en']
        }));
        if (result)
            return (Object.values(result.entities)[0] as any).labels.en.value;
        return id;
    }
}