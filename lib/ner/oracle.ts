import { Entity, Linker } from './base';
import WikidataUtils from '../utils/wikidata';

export class OracleLinker extends Linker {
    private _wikidata : WikidataUtils;

    constructor(wikidata : WikidataUtils) {
        super();
        this._wikidata = wikidata;
    }
    
    async run(id : string, utterance : string, thingtalk : string) {
        const matches = thingtalk.match(/Q[0-9]+/g);
        const entities : Entity[] = [];
        for (const match of matches ? [...new Set(matches)] : []) {
            const domainId = await this._wikidata.getDomain(match);
            entities.push({
                id: match,
                label: (await this._wikidata.getLabel(match))!,
                domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                type: 'entity',
            });
        }
        return { entities, relations: [] };
    }

}