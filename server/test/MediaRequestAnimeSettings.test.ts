import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import type {
  AddSeriesOptions,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import requestDispatchManager from '@server/lib/requestDispatch';
import { getSettings, type SonarrSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { resetTestDb, seedTestDb } from '@server/utils/seedTestDb';

const ANIME_TMDB_ID = 9101;
const ANIME_TVDB_ID = 19101;

const STANDARD = { profileId: 4, directory: '/tv', tags: [11] };
const ANIME = { profileId: 8, directory: '/anime', tags: [22] };

function configureSonarrWithAnimeDefaults(): SonarrSettings {
  const sonarr: SonarrSettings = {
    id: 51,
    name: 'Sonarr',
    hostname: 'sonarr.local',
    port: 8989,
    apiKey: 'test-key',
    useSsl: false,
    activeProfileId: STANDARD.profileId,
    activeProfileName: 'HD',
    activeDirectory: STANDARD.directory,
    activeLanguageProfileId: 1,
    tags: [...STANDARD.tags],
    activeAnimeProfileId: ANIME.profileId,
    activeAnimeProfileName: 'Anime',
    activeAnimeDirectory: ANIME.directory,
    activeAnimeLanguageProfileId: 1,
    animeTags: [...ANIME.tags],
    is4k: false,
    isDefault: true,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    seriesType: 'standard',
    animeSeriesType: 'anime',
    enableSeasonFolders: true,
    monitorNewItems: 'all',
    overrideRule: [],
  };
  getSettings().sonarr = [sonarr];
  return sonarr;
}

function mockAnimeTmdbShow() {
  (
    mock.method as (
      object: object,
      methodName: string,
      implementation: () => Promise<unknown>
    ) => unknown
  )(ExternalAPI.prototype, 'get', async () => ({
    id: ANIME_TMDB_ID,
    name: 'Anime Regression Show',
    original_language: 'ja',
    genres: [{ id: 16, name: 'Animation' }],
    external_ids: { tvdb_id: ANIME_TVDB_ID },
    keywords: { results: [{ id: ANIME_KEYWORD_ID, name: 'anime' }] },
    seasons: [{ season_number: 1, air_date: '2024-01-01', episode_count: 12 }],
  }));
}

describe('anime Sonarr settings for non-advanced requests', () => {
  before(async () => {
    await seedTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    mock.method(requestDispatchManager, 'enqueue', async () => undefined);
    mock.method(MediaRequest, 'sendNotification', async () => undefined);
  });

  afterEach(() => {
    mock.restoreAll();
    getSettings().sonarr = [];
  });

  it('sends the anime profile, root folder, and tags to Sonarr', async () => {
    configureSonarrWithAnimeDefaults();
    mockAnimeTmdbShow();

    mock.method(SonarrAPI.prototype, 'getProfiles', async () => [
      { id: STANDARD.profileId, name: 'HD' },
      { id: ANIME.profileId, name: 'Anime' },
    ]);
    mock.method(SonarrAPI.prototype, 'getLanguageProfiles', async () => []);
    let addSeriesOptions: AddSeriesOptions | undefined;
    mock.method(
      SonarrAPI.prototype,
      'addSeries',
      async (options: AddSeriesOptions) => {
        addSeriesOptions = options;
        return {
          id: 301,
          title: 'Anime Regression Show',
          titleSlug: 'anime-regression-show',
        } as SonarrSeries;
      }
    );

    // The seeded friend user holds only REQUEST, so advanced request options
    // are unavailable and the request falls back to server defaults.
    const requester = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const created = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: ANIME_TMDB_ID,
        tvdbId: ANIME_TVDB_ID,
        seasons: [1],
        is4k: false,
      },
      requester
    );

    const stored = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.id },
      relations: { media: true, requestedBy: true, seasons: true },
    });
    // Record what request creation persisted, so a failure shows its origin.
    const persisted = {
      profileId: stored.profileId,
      rootFolder: stored.rootFolder,
      tags: stored.tags,
    };

    stored.status = MediaRequestStatus.APPROVED;
    for (const season of stored.seasons) {
      season.status = MediaRequestStatus.APPROVED;
    }
    await new MediaRequestSubscriber().sendToSonarr(stored);

    assert.ok(addSeriesOptions, 'Sonarr addSeries was not called');
    assert.deepEqual(
      {
        profileId: addSeriesOptions.profileId,
        rootFolderPath: addSeriesOptions.rootFolderPath,
        tags: addSeriesOptions.tags,
        seriesType: addSeriesOptions.seriesType,
      },
      {
        profileId: ANIME.profileId,
        rootFolderPath: ANIME.directory,
        tags: ANIME.tags,
        seriesType: 'anime',
      },
      `request creation persisted ${JSON.stringify(persisted)}`
    );
  });
});
