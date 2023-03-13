import { Example, Entity, Linker, LinkerResult } from './base';
import WikidataUtils from '../utils/wikidata';

export class ReFinEDLinker extends Linker {
    private _wikidata : WikidataUtils;

    constructor(wikidata : WikidataUtils) {
        super();
        this._wikidata = wikidata;
    }
    
    async run(id : string, utterance : string, thingtalk : string) : Promise<LinkerResult> {
        throw Error('Use runAll for ReFinEDLinker');
    }

    async runAll(examples : Example[]) {
        // TODO
    }
}