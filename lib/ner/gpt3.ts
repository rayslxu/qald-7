import fs from 'fs';
import * as Tp from 'thingpedia';
import { Entity, Linker } from './base';
import WikidataUtils from '../utils/wikidata';
import Cache from '../utils/cache';

interface GPT3EntityLinkerOptions {
    ner_cache : string,
    raw_data ?: string
}

function sleep(ms : number) {
    return new Promise((res) => setTimeout(res, ms));
}

export class GPT3Linker extends Linker {
    private _wikidata : WikidataUtils;
    private _url : string;
    private _cache : Cache;
    private _rawData : Record<string, string>;
    // private _timeOfInceptionProperties : string[];

    constructor(wikidata : WikidataUtils, options : GPT3EntityLinkerOptions) {
        super();
        this._wikidata = wikidata;
        this._url = 'https://wikidata.openai.azure.com/openai/deployments/text/completions?api-version=2022-12-01';
        this._cache = new Cache(options.ner_cache);
        this._rawData = {};
        // this._timeOfInceptionProperties = ["P569", "P580", "P577", "P571", "P585", "P575"];
        if (options.raw_data) {
            for (const ex of JSON.parse(fs.readFileSync(options.raw_data, 'utf-8')).questions)
                this._rawData[ex.id] = ex.question[0].string;
        }
    }

    async run(id : string, utterance : string) {
        if (id in this._rawData)
            utterance = this._rawData[id];
        const cache = await this._cache.get(utterance);
        if (cache)
            return JSON.parse(cache);
        const entities : Entity[] = [];

        if (!process.env.OPENAI_API_KEY)
            throw new Error('Missing environment variable OPENAI_API_KEY');

        const prompt = this._prompt(utterance);

        await sleep(600);
        const raw = await Tp.Helpers.Http.post(this._url, JSON.stringify({ prompt, max_tokens: 500, temperature: 0 }), {
             dataContentType: 'application/json',
             extraHeaders: { 'api-key': process.env.OPENAI_API_KEY as string }
        });

        const res = JSON.parse(raw);
        if (res.choices.length > 0 && res.choices[0].text.length > 0) {
            const entitiesFound = res.choices[0].text.trim().split('\n').slice(1);
            console.log(`Entities found for ${utterance}: `);
            console.log(entitiesFound);
            for (const entity of entitiesFound) {
                if (!entity)
                    continue;
                const [name, toi, propertiesReturnedUncleaned] = entity.split('; ');
                let propertiesReturned = '';
                if (propertiesReturnedUncleaned) {
                    if (propertiesReturnedUncleaned.trim().substring(propertiesReturnedUncleaned.length - 1) === '#')
                        propertiesReturned = propertiesReturnedUncleaned.trim().substring(0, propertiesReturnedUncleaned.length - 1);
                    else
                        propertiesReturned = propertiesReturnedUncleaned.trim();
                }
                if (!name || name === '')
                    continue;
                let potentialEntities = await this._wikidata.getAllEntitiesByName(name);
                if (!potentialEntities || potentialEntities.length === 0) {
                    // throw new Error('Cannot find Wikidata entity for: ' + name);
                    console.error('Cannot find Wikidata entity for "' + name + '" from "' + utterance + '"');
                    continue;
                }

                const entitiesWithCorrectType = [];
                for (const matchingEntity of potentialEntities) {
                    const propertyMatch = await this._checkTypeMatch(matchingEntity, propertiesReturned);
                    if (propertyMatch)
                        entitiesWithCorrectType.push(matchingEntity);
                }
                if (entitiesWithCorrectType.length > 0)
                    potentialEntities = entitiesWithCorrectType;

                const entitiesWithExactNameMatch = [];
                for (const matchingEntity of potentialEntities) {
                    if (matchingEntity.label === name)
                        entitiesWithExactNameMatch.push(matchingEntity);
                }
                if (entitiesWithExactNameMatch.length > 0)
                    potentialEntities = entitiesWithExactNameMatch;


                // if (entities.length > 0) {
                //     if (entitiesWithValidDesciptions.length === 0) { // Need to sweep back through all potential entities
                //         for (const matchingEntity of potentialEntities) {
                //             for (const priorEntity of entities) {
                //                 const isNearHopMatch = await this._checkHopDistance(matchingEntity.id, priorEntity.id, 1);
                //                 if (isNearHopMatch) {
                //                     const domainId = await this._wikidata.getDomain(matchingEntity.id);
                //                     entities.push({
                //                         id: matchingEntity.id,
                //                         label: matchingEntity.label,
                //                         domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                //                         type: 'entity'
                //                     });
                //                     continue;
                //                 }
                //             }
                //         }
                //     } else { // Only check against entities with matching descriptions
                //         for (const matchingEntity of entitiesWithValidDesciptions) {
                //             for (const priorEntity of entities) {
                //                 const isNearHopMatch = await this._checkHopDistance(matchingEntity.id, priorEntity.id, 1);
                //                 if (isNearHopMatch) {
                //                     const domainId = await this._wikidata.getDomain(matchingEntity.id);
                //                     entities.push({
                //                         id: matchingEntity.id,
                //                         label: matchingEntity.label,
                //                         domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                //                         type: 'entity'
                //                     });
                //                     continue;
                //                 }
                //             }
                //         }
                //     }
                // }

                const matchCounts : Record<string, number> = {};

                // const maxMatchCount = propertiesReturned.split(',').length;
                if (!propertiesReturned || propertiesReturned === '' || propertiesReturned.trim() === 'N/A') {
                    for (const matchingEntity of potentialEntities)
                        matchCounts[matchingEntity.id] = 0;
                } else {
                    for (const matchingEntity of potentialEntities) {
                        const matchCount = await this._checkPropertyMatchs(matchingEntity, propertiesReturned);
                        matchCounts[matchingEntity.id] = matchCount;
                    }
                }

                const entitiesSortedByMatching = potentialEntities.sort((entity1 : any, entity2 : any) => matchCounts[entity1.id] > matchCounts[entity2.id]);

                let foundMatch = false;
                for (const matchingEntity of entitiesSortedByMatching) {
                    const propertyMatch = await this._propertiesMatchDescription(propertiesReturned + ', ' + toi, matchingEntity.description);
                    if (propertyMatch) {
                        const domainId = await this._wikidata.getDomain(matchingEntity.id);
                        entities.push({
                            id: matchingEntity.id,
                            label: matchingEntity.label,
                            domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                            type: 'entity'
                        });
                        foundMatch = true;
                        break;
                    }
                }
                
                if (!foundMatch) {
                    const domainId = await this._wikidata.getDomain(entitiesSortedByMatching[0].id);
                    entities.push({
                        id: entitiesSortedByMatching[0].id,
                        label: entitiesSortedByMatching[0].label,
                        domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                        type: 'entity'
                    });
                }
            }
        }
             

        const result = { entities, relations: [] };

        this._cache.set(utterance, JSON.stringify(result));
        return result;
    }

    // private async _checkHopDistance(matchId : string, priorMatch : string, maxHopDistance : number) {
    //     if (maxHopDistance === 0)
    //         return false;
    //     if (!this._wikidata.isEntity(matchId))
    //         return false;
    //     const propertyIds = await this._wikidata.getConnectedProperty(matchId, false);
    //     const chunkSize = 10;

    //     const propertyValueQIDs = [];
    //     for (let chunkStart = 0; chunkStart < propertyIds.length; chunkStart += chunkSize) {
    //         const propertyValueQIDsChunk = await Promise.all(propertyIds.slice(chunkStart, chunkStart + chunkSize).map((id) => this._wikidata.getPropertyValue(matchId, id)));
    //         propertyValueQIDs.push(...propertyValueQIDsChunk);
    //     }

    //     for (const qid of propertyValueQIDs.flat()) {
    //         if (qid === priorMatch)
    //             return true;
    //         if (await this._checkHopDistance(qid, priorMatch, maxHopDistance - 1))
    //             return true;
    //     }
    //     return false;
    // }


    private async _checkPropertyMatchs(match : any, propertiesToCheck : string) {
        const propertyIds = await this._wikidata.getConnectedProperty(match.id, false);
        const chunkSize = 10;

        const propertyValueQIDs = [];
        for (let chunkStart = 0; chunkStart < propertyIds.length; chunkStart += chunkSize) {
            const propertyValueQIDsChunk = await Promise.all(propertyIds.slice(chunkStart, chunkStart + chunkSize).map((id) => this._wikidata.getPropertyValue(match.id, id)));
            propertyValueQIDs.push(...propertyValueQIDsChunk);
        }

        const propertyValues = [];
        for (let chunkStart = 0; chunkStart < propertyIds.length; chunkStart += chunkSize) {
            const propertyValuesChunk = await Promise.all(propertyValueQIDs.flat().slice(chunkStart, chunkStart + chunkSize).filter((id) => this._wikidata.isEntity(id)).map((id) => this._wikidata.getLabel(id)));
            propertyValues.push(...propertyValuesChunk);
        }

        let matches = 0;
        for (const propertyValue of propertyValues) {
            if (!propertyValue)
                continue;
            if (propertiesToCheck.toLowerCase().includes(propertyValue.toLowerCase()))
                matches += 1;
        }
        return matches;
    }

    private async _propertiesMatchDescription(properties : string, descriptionOfEntity : string) {
        const description = 'Determine if the properties match the description\n\n';

        const examples = 
                        'Properties: German, Scientist, Physicist, special Relativity, general relativity, Jewish, quantum mechanics, walrus moustache\n' + 
                        'Description: German-born theoretical physicist; developer of the theory of relativity\n' + 
                        'Answer: yes\n' +
                        '\n' +
                        'Properties: Film, Fantasy, Fantasy Film, J. R. R. Tolkien, The Two Towers, Peter Jackson, John Noble\n' + 
                        'Description: 2001-2003 three films directed by Peter Jackson\n' +
                        'Answer: yes\n' +
                        '\n' +
                        'Properties: Mountain, Nepal, Himalayas, Annapurna Conservation Area Project, Annapurna Sanctuary, Annapurna I\n' + 
                        'Description: mountain range in the Himalayas\n' +
                        'Answer: no\n' +
                        '\n' +
                        'Properties: Mountain, Nepal, Himalayas, Annapurna Conservation Area Project, Annapurna Sanctuary, Annapurna I\n' + 
                        'Description: mountain in the Himalayas\n' +
                        'Answer: yes\n' +
                        '\n' +
                        'Properties: President, Arkansas, Democrat, Georgetown University, Oxford University, Hot Springs High School\n' + 
                        'Description: president of the United States from 1961 to 1963\n' +
                        'Answer: yes\n' +
                        '\n' +
                        'Properties: Country, Oceania, Commonwealth of Australia, Canberra, Australian Dollar, Mountain\n' + 
                        'Description: continent on the Earth\'s Southern Hemisphere\n' +
                        'Answer: no\n' +
                        '\n' +
                        'Properties: River, Germany, Munich, Lake\n' + 
                        'Description: river in Tyrol, Austria and Bavaria, Germany\n' +
                        'Answer: yes\n' +
                        '\n';

        const question = `Properties: ${properties}\n` +
                          `Description: ${descriptionOfEntity}\n` +
                          'Answer:';

        const prompt = description + examples + question;

        await sleep(600);
        const raw = await Tp.Helpers.Http.post(this._url, JSON.stringify({ prompt, max_tokens: 500, temperature: 0 }), {
             dataContentType: 'application/json',
             extraHeaders: { 'api-key': process.env.OPENAI_API_KEY as string }
        });

        const res = JSON.parse(raw);
        if (res.choices.length > 0 && res.choices[0].text.length > 0) {
            const match = res.choices[0].text.trim();
            if (match === 'yes')
                return true;
            else
                return false;
        }
        return true;
    }

    private async _checkTypeMatch(match : any, propertiesToCheck : string) {
        const typeIds = await this._wikidata.getPropertyValue(match.id, 'P31');
        const typePropertyValues = [];
        for (const typeId of typeIds)
            typePropertyValues.push(await this._wikidata.getLabel(typeId));

        for (const typeProperty of typePropertyValues) {
            if (!typeProperty)
                continue;
            if (propertiesToCheck.toLowerCase().includes(typeProperty.toLowerCase()))
                return true;
        }
        return false;
    }

    // Kept just in case we ever want to bring TOI matching back, but commented out because its dropped for now
    /*
    private async _checkMatchTOI(matchingEntity : any, toiString : string|null) : Promise<boolean> {
        const id = matchingEntity.id;
        if (toiString && !toiString.includes('N/A')) {
            const inceptionDate = new Date(toiString);
            for (const toiProp of this._timeOfInceptionProperties) {
                const propValue = await this._wikidata.getPropertyRawValue(id, toiProp);
                if (propValue.length === 0)
                    continue;
                for (const potentialTOI of propValue) {
                    const foundInceptionDate = new Date(potentialTOI);
                    // Round to nearest day
                    if (Math.floor(foundInceptionDate.getTime() / 86400000) !== Math.floor(inceptionDate.getTime() / 86400000))
                        continue;
                    return true;
                }
            }
            return false;
        }
        return false;
    }
    */

    private _prompt(utterance : string) : string {
        const description = 'Return named entities, the date of their inception, and distinct properties and types about them. The names of entities should be singular, and acronyms should be avoided.\n\n';

        const examples = 
                        'Sentence: Who was the doctoral supervisor of Albert Einstein ?\n' +
                        'Entities: Albert Einstein\n' +
                        'Albert Einstein; 14 March, 1879; German, Scientist, Physicist, special Relativity, general relativity, Jewish, quantum mechanics, walrus moustache, human #\n' +
                        '\n' +
                        'Sentence: what character did natalie portman play in star wars?\n' +
                        'Entities: Natalie Portman, Star Wars\n' +
                        'Natalie Portman; 9 June, 1981; Actress, female, Producer, Director, Israel, Harvard, Star Wars, V for Vendetta, Black Swan, Thor, human #\n' +
                        'Star Wars; 1977; Film, science fiction, franchise, George Lucas, Skywalker Saga, Star Wars Rebels, The Mandalorian, Star Wars: The Clone Wars, Star Wars: The Rise of Skywalker, Lightsaber, film series #\n' +
                        '\n' +
                        'Sentence: what kind of money to take to bahamas?\n' +
                        'Entities: Bahamas\n' +
                        'Bahamas; 10 July, 1973; Country, Caribbean, Commonwealth of the Bahamas, Nassau, Grand Bahama, Bahamian Dollar #\n' +
                        '\n' +
                        'Sentence: what character did john noble play in lord of the rings?\n' +
                        'Entities: John Noble, Lord of the Rings\n' +
                        'John Noble; 20 August, 1948; Actor, Australian, Australia, Voice Actor, Rostrevor College, Lord of the Rings, human #\n' +
                        'Lord of the Rings; 19 December, 2001; Film, Fantasy, Fantasy Film, J. R. R. Tolkien, The Two Towers, Peter Jackson, John Noble, film trilogy #\n' +
                        '\n' +
                        'Sentence: what high school did president bill clinton attend?\n' +
                        'Entities: Bill Clinton, High School\n' +
                        'Bill Clinton; 19 August, 1946; President, Arkansas, Democrat, Georgetown University, Oxford University, Hot Springs High School, human #\n' +
                        'High School; 1128; Education, Secondary Education, ninth grade, tenth grade, eleventh grade, twelfth grade #\n' +
                        '\n' +
                        'Sentence: Are tree frogs a type of amphibian?\n' +
                        'Entities: Tree Frog, Amphibian\n' +
                        'Tree Frog; 70600000 BCE; Amphibian, Anura, Hylidae, Hylinae, Hyla, Arboreal, Nocturnal, Tropical, Subtropical, taxon #\n' +
                        'Amphibian; 370 Million BCE; Animal, Vertebrate, Cold-blooded, Moist Skin, Metamorphosis, Frogs, Toads, Salamanders, Caecilians, taxon #\n' +
                        '\n' +
                        'Sentence: Which writers studied in Istanbul?\n' +
                        'Entities: Istanbul, Writer\n' +
                        'Istanbul; 29 May, 1453; City, Turkey, Bosphorus, Sea of Marmara, Black Sea, Writers #\n' +
                        'Writer; 3400 BCE; Profession, Authors, Poets, Novelists, Playwrights, Journalists, Istanbul #\n' +
                        '\n' +
                        'Sentence: give me a list of all critically endangered birds .\n' + 
                        'Entities: Bird, Critically Endangered\n' + 
                        'Bird; 53 Million BCE; Animal, Vertebrate, Aves, Feathers, Wings, Critically Endangered, taxon #\n' + 
                        'Critically Endangered; 1948; Status, Extinction, Wildlife, Poaching, Habitat Loss, Birds #\n' + 
                        '\n' +
                        'Sentence: how many emperors did china have ?\n' +
                        'Entities: Emperor of China, China\n' +
                        'Emperor of China; 221 BCE; Title, Chinese, Dynasties, Imperial China, Qing Dynasty, Ming Dynasty, Han Dynasty, Zhou Dynasty, historical position #\n' +
                        'China; 1 October, 1949; Country, East Asia, Communist, Beijing, People\'s Republic of China, Emperors #\n' +
                        '\n' +
                        'Sentence: who became president after jfk died ?\n' +
                        'Entities: John F Kennedy, President of the United States, United States\n' +
                        'John F Kennedy; 29 May, 1917; President, United States, Democrat, Assassination, Aftermath, human #\n' +
                        'President of the United States; 30 April, 1787; Title, Executive, Head of State, John F Kennedy, Lyndon B Johnson, elective office, head of government #\n' +
                        'United States; 4 July, 1776; Country, North America, Constitutional Republic, Washington D.C., Congress, President #\n' +
                        '\n' +
                        'Sentence: what does chilean people speak ?\n' +
                        'Entities: Chile\n' +
                        'Chile; 18 September, 1810; Country, South America, Santiago, Chilean Spanish, Mapuche, Rapa Nui, Quechua, Aymara, human #\n' +
                        '\n' +
                        'Sentence: what was the name of the book that charles darwin wrote ?\n' +
                        'Entities: Charles Darwin, Book\n' +
                        'Charles Darwin; 12 February, 1809; Scientist, Naturalist, English, The Origin of Species, Voyage of the Beagle, human #\n' +
                        'Book; 3400 BCE; Written Work, Literature, Charles Darwin, The Origin of Species, Voyage of the Beagle, publication #\n' +
                        '\n' +
                        'Sentence: what do you call russian currency ?\n' +
                        'Entities: Russia\n' +
                        'Russia; 22 August, 1991; Country, Eurasia, Moscow, Ruble, Currency #\n' +
                        '\n';

        const question = `Sentence: ${utterance}\n` +
                          'Entities:';


        return description + examples + question;
    }
}