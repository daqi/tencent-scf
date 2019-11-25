const util = require('util')
const fs = require('fs')
const ignore = require('ignore')
const _ = require('lodash')
const Zip = require('./zip')
const path = require('path')
const AdmZip = require('adm-zip')
const globby = require('globby')
const { contains, isNil, last, split } = require('ramda')

const VALID_FORMATS = ['zip', 'tar']
const isValidFormat = (format) => contains(format, VALID_FORMATS)

module.exports = {
  zipArchiveDirs(zipObject, dirPath, alias, packagePath, ig) {
    const dirs = fs.readdirSync(dirPath)
    if (!dirs) {
      throw new Error('cannot read function file. ' + dirPath)
    }

    for (let i = 0; i < dirs.length; i++) {
      const filePath = util.format('%s/%s', dirPath, dirs[i])
      const fullAlias = util.format('%s/%s', alias, dirs[i])
      const fstat = fs.statSync(filePath)
      if (fstat.isDirectory()) {
        this.zipArchiveDirs(zipObject, filePath, fullAlias, packagePath, ig)
      } else {
        if (_.isEmpty(ig)) {
          zipObject.addFile(filePath, fullAlias)
          continue
        }

        if (!ig.ignores(fullAlias)) {
          zipObject.addFile(filePath, fullAlias)
          continue
        }
      }
    }
    return true
  },

  async zipArchive(packagePath, outZipFile, ignoreFile) {
    const dirs = fs.readdirSync(packagePath)
    if (!dirs) {
      throw new Error('cannot read function file. ' + packagePath)
    }

    let ig
    if (ignoreFile && !_.isEmpty(ignoreFile)) {
      ig = ignore().add(ignoreFile)
    } else {
      ig = null
    }

    const zip = new Zip(outZipFile)
    for (let i = 0; i < dirs.length; i++) {
      // if (dirs[i] == Constants.ScfZipTmpDir) continue; // skip
      const filePath = util.format('%s/%s', packagePath, dirs[i])

      const fstat = fs.statSync(filePath)
      if (fstat.isFile()) {
        if (_.isEmpty(ig)) {
          zip.addFile(filePath, dirs[i])
          continue
        }

        if (!ig.ignores(dirs[i])) {
          zip.addFile(filePath, dirs[i])
          continue
        }
      }

      if (fstat.isDirectory()) {
        this.zipArchiveDirs(zip, filePath, dirs[i], packagePath, ig)
      }
    }
    const size = await zip.finalize()
    return size
  },
  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  },

  async packDir(inputDirPath, outputFilePath, include = [], exclude = []) {
    const format = last(split('.', outputFilePath))

    if (!contains(format, ['zip', 'tar'])) {
      throw new Error('Please provide a valid format. Either a "zip" or a "tar"')
    }

    const patterns = ['**']

    if (!isNil(exclude)) {
      exclude.forEach((excludedItem) => patterns.push(`!${excludedItem}`))
    }

    const zip = new AdmZip()

    const files = (await globby(patterns, { cwd: inputDirPath })).sort()

    files.map((file) => {
      if (file === path.basename(file)) {
        zip.addLocalFile(path.join(inputDirPath, file))
      } else {
        zip.addLocalFile(path.join(inputDirPath, file), path.dirname(file))
      }
    })

    if (!isNil(include)) {
      include.forEach((file) => zip.addLocalFile(path.join(inputDirPath, file)))
    }

    zip.writeZip(outputFilePath)

    return outputFilePath
  }
}
