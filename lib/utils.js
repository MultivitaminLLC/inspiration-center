'use strict';

let path = require('path')
let fs = require('fs')
let tv4 = require('tv4')
let request = require('request')
let keywordExtractor = require("keyword-extractor");

const BLOG_ARTICLES_API_URL = 'https://realtimeboard.com/blog/api/get_post/'
const BLOG_ARTICLES_API_PARAMS = {
	include: 'title,thumbnail'
}

const KEYWORD_EXTRACTOR_CONFIG = {
	language:"english",
    remove_digits: true,
    return_changed_case:true,
    remove_duplicates: true
}

function getKeywords(sentences) {
	if (!sentences || !sentences.length) {
		return []
	}

	let sentence = sentences.join(' ')
	let result = keywordExtractor.extract(sentence, KEYWORD_EXTRACTOR_CONFIG)
	return result
}

function parseVideo(parser, url, getTags) {
	return new Promise((resolve, reject) => {
		parser.parse((err, videoInfo) => {
			if (err) {
				throw `Parsing video error\nVideo url: ${url}\nMessage: ${err}`
			} else {
				let result = {
					id: videoInfo.id,
					url: videoInfo.embedSrc,
					title: videoInfo.name,
					thumbnail: videoInfo.thumb_url,
					lowResImage: videoInfo.lowResImage || '',
					normalImage: videoInfo.normalImage || '',
					highResImage: videoInfo.highResImage || ''
				}
				if (getTags) {
					result.tags = getKeywords([videoInfo.name, videoInfo.desc])
				}
				resolve(result)
			}
		}, url)
	})
}

function parseBlogArticle(url) {
	return new Promise((resolve, reject) => {
		let slug = path.basename(url)
		let queryString = Object.assign({slug}, BLOG_ARTICLES_API_PARAMS)
		let requestParams = {
			url: BLOG_ARTICLES_API_URL,
			qs: queryString
		}
		request(requestParams, function (err, res, body) {
		    if (err) {
		    	console.dir(err)
			    reject(err)
			    return
		    }

	    	var result = JSON.parse(body)
	    	let post = result.post
	    	if (!post) {
	    		console.log(`Blog articles API failed: ${slug}`)
    			reject(`Blog articles API failed: ${slug}`)
    			return
	    	}

	    	let thumbnailImages = post.thumbnail_images
			let lowResImage = thumbnailImages && thumbnailImages.thumbnail
			let normalImage = thumbnailImages && (thumbnailImages.medium || thumbnailImages.medium_large || thumbnailImages.large || thumbnailImages.full)

	    	resolve({
	    		id: post.id,
	    		title: post.title,
	    		url,
	    		thumbnail: normalImage ? normalImage.url : '', // delete after client release
    			normalImage: normalImage ? normalImage.url : '',
    			lowResImage: lowResImage ? lowResImage.url : ''
	    	})
		})    
	})
}

function composeId(sourceObject, field, extension) {
	let fieldValue = sourceObject[field]
	return path.basename(fieldValue, extension)
}

function setLinksIds(links) {
	if (!links) {
		links = []
	}

	return links.map(link => {
		return Object.assign(link, {id: composeId(link, 'url')})
	})
}

function populateLinks(links, sourceCollection) {
	if (!sourceCollection) {
		return []
	}

	if (!links) {
		links = []
	}

	return links.reduce((prev, link) => {
		let foundElement = sourceCollection.find(sourceElement => sourceElement.id === link)
		if (foundElement) {
			let linkElement = Object.assign({}, foundElement)
			delete linkElement.tags
			prev.push(linkElement)
		}
		// todo // throw error if not found
		return prev
	}, [])
}

// filter only successfully parsed videos
function prepareVideos(videos) {
	return videos
		.filter(video => video)
}

module.exports.prepareData = (config, parser) => {
	return new Promise((resolve, reject) => {
		// populate videos collection
		let videoPromises = config.videos.map(video => parseVideo(parser, video, true))

		let videosPromise = Promise.all(videoPromises)
			.then(results => {
				return prepareVideos(results)
			})

		// populate videos in use cases
		// todo use on any collection
		// todo check file references
		let useCasePromises = config.useCases.map(item => {
			let videos = item.videos || []
			let videoPromises = Promise.all(videos.map(videoUrl => parseVideo(parser, videoUrl)))
			let blogArticles = item.blogArticles || []
			let blogArticlePromises = Promise.all(blogArticles.map(blogArticleUrl => parseBlogArticle(blogArticleUrl)))
			item.helpTopics = setLinksIds(item.helpTopics)

			return Promise.all([videoPromises, blogArticlePromises])
				.then(results => {
					item.videos = prepareVideos(results[0])
					item.blogArticles = results[1]
					return item
				})
		})

		// Getting started
		let gettingStartedPromises = config.gettingStarted.map(item => {
			let videos = item.videos || []
			let videoPromises = Promise.all(videos.map(videoUrl => parseVideo(parser, videoUrl)))
			item.helpTopics = setLinksIds(item.helpTopics)
			item.howTo = populateLinks(item.howTo, config.howTo)
			item.guides = populateLinks(item.guides, config.guides)
			item.shortcuts = populateLinks(item.shortcuts, config.shortcuts)
			item.interfaceExplained = populateLinks(item.interfaceExplained, config.interfaceExplained)
			item.tutorials = populateLinks(item.tutorials, config.tutorials)

			return Promise.all([videoPromises])
				.then(results => {
					item.videos = prepareVideos(results[0])
					return item
				})
		})

		let useCasePromise = Promise.all(useCasePromises)
		let gettingStartedPromise = Promise.all(gettingStartedPromises)

		Promise.all([videosPromise, useCasePromise, gettingStartedPromise])
			.then((results) => {
				config.videos = results[0]
				config.useCases = results[1]
				config.gettingStarted = results[2]
				resolve(config)
			})
			.catch(err => {
				console.log(err)
				reject(err)
			})
	})
}

module.exports.validateJSON = (filePath, fileContents) => {
	return new Promise((resolve, reject) => {
		let cwd = process.cwd()
		let relativePath = path.relative(cwd + '/src', filePath)
		let dirname = path.dirname(relativePath)
		let schemaName
		if (dirname !== '.') {
			schemaName = dirname
		} else {
			schemaName = path.basename(relativePath, '.json')
		}

		fs.readFile(path.join(cwd, 'schemas', `${schemaName}.json`), (err, data) => {
			if (err) {
				console.dir(err)
				throw  `Schema validation error\n` +
				       `Could not find schema for file: ${filePath}`
			}
			let schema = JSON.parse(data.toString())
			let contents = JSON.parse(fileContents.toString())
			let valid = tv4.validate(contents, schema)

			if (valid) {
				if (tv4.missing && tv4.missing.length) {
				throw  `Schema validation error\n` +
				       `File path: ${filePath}\n` +
				       `Missing schemas: ${JSON.stringify(tv4.missing)}`
				} else {
					resolve()
				}
			} else {
				throw  `Schema validation error\n` +
				       `File path: ${filePath}\n` +
				       `Data path: ${tv4.error.dataPath}\n` +
				       `Message: ${tv4.error.message}`
			}
		})
	})
}