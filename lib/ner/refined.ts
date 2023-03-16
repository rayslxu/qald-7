import { Example, Linker, LinkerResult } from './base';

export class ReFinEDLinker extends Linker {
    constructor() {
        super();
    }
    
    async run(id : string, utterance : string, thingtalk : string) : Promise<LinkerResult> {
        throw Error('Use runAll for ReFinEDLinker');
    }

    async saferunAll(examples : Example[]) {
        // TODO
    }
}