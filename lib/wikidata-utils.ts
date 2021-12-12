import * as Tp from 'thingpedia';
import { wikibaseSdk } from 'wikibase-sdk'; 
import wikibase from 'wikibase-sdk';

const URL = 'https://query.wikidata.org/sparql';
const ENTITY_PREFIX = 'http://www.wikidata.org/entity/';

export default class WikidataUtils {
    private _wdk : wikibaseSdk;
    private _cache : Record<string, any>;

    constructor() {
        this._wdk = wikibase({ instance: 'https://www.wikidata.org' });
        this._cache = {};
    }

    /**
     * Obtain results of a SPARQL query against Wikidata SPARQL endpoint
     * @param sparql a SPARQL query
     * @returns A list of the results
     */
    private async _query(sparql : string) {
        console.log(sparql);
        const result = await this._request(`${URL}?query=${encodeURIComponent(sparql)}`);
        return result.results.bindings;
    }

    /**
     * Obtain results of URL in JSON form (Wikibase API call)
     * @param url 
     * @returns An object of the result
     */
    private async _request(url : string) {
        if (url in this._cache) 
            return this._cache[url];
        try {
            const result = await Tp.Helpers.Http.get(url, { accept: 'application/json' });
            const parsed = JSON.parse(result);
            this._cache[url] = parsed;
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